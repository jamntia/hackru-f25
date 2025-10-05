"""Application service file."""

# Imports
import os, tempfile, uuid, json
from dotenv import load_dotenv
from typing import Optional, List, Dict, Any, Literal
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from supabase import create_client, Client
import traceback, logging
logger = logging.getLogger("svc")

# Import existing modules
from .pdf_parser import ingest_pdf
from .image_parser import ingest_image
from .rag import answer_question

# Load environment variables and initialize client
load_dotenv()
url = os.getenv("SUPABASE_URL")
service_key = os.getenv("SUPABASE_SERVER_ROLE_KEY")
assert url and service_key, "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"

sb: Client = create_client(url, service_key)

# Set up FastAPI app
app = FastAPI(
    title="Tutor Service",
    version="0.1.0",
    docs_url="/docs",
    openapi_url="/openapi.json",
)

# Open up to dev UI origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Constants
MAX_PDF_MB = 100

# Schemas
class CourseIn(BaseModel):
    name: str
    term: Optional[str] = None

class CourseOut(BaseModel):
    id: str
    name: str
    term: Optional[str] = None

class ChatIn(BaseModel):
    course_id: str
    question: str
    assistance_level: Literal["novice","exam_prep","advanced"] = "exam_prep"
    mode: Literal["worked","socratic","exam"] = "worked"
    k: Optional[int] = None

class ChatOut(BaseModel):
    answer: str
    sources: List[Dict[str, Any]]
    sources_dedup: Optional[List[Dict[str, Any]]] = None
    meta: Optional[Dict[str, Any]] = None

# Helpers
def get_owner_id(owner_id_header: Optional[str], owner_id_body: Optional[str]) -> str:
    # Prefer X-User-Id header (Supabase Auth user UUID from the UI).
    # Fall back to owner_id provided in body for upload endpoints
    owner = owner_id_header or owner_id_body
    if not owner:
        raise HTTPException(status_code=401, detail="Missing owner id. Set X-User-Id header.")
    return owner

def get_or_create_course(owner_id: str, name: str, term: Optional[str]) -> str:
    from postgrest.exceptions import APIError
    try:
        cid = sb.rpc("create_course_rpc", {
            "p_name": name, "p_term": term, "p_owner": owner_id
        }).execute().data
        return cid
    except APIError as e:
        if getattr(e, "code", None) == "23505" or "unique constraint" in str(e).lower():
            row = (sb.table("courses")
                   .select("id, name, term")
                   .eq("owner_id", owner_id)
                   .eq("name", name)
                   .limit(1)
                   .execute())
            if row.data:
                return row.data[0]["id"]
        raise

# Routes
@app.get("/healthz")
def healthz():
    # Check DB connectivy by listing 1 course id
    try:
        _ = sb.table("courses").select("id").limit(1).execute()
        ok = True
    except Exception:
        ok = False
    return {"ok": ok}

@app.get("/courses", response_model=List[CourseOut])
def list_courses(x_user_id: Optional[str] = Header(default=None)):
    owner = get_owner_id(x_user_id, None)
    rows = (sb.table("courses")
            .select("id, name, term")
            .eq("owner_id", owner)
            .order("created_at", desc=True)
            .execute()).data or []
    return rows

@app.post("/courses", response_model=CourseOut)
def create_course(course: CourseIn, x_user_id: Optional[str] = Header(default=None)):
    owner = get_owner_id(x_user_id, None)
    course_id = get_or_create_course(owner, course.name, course.term)
    # Return newly created/found row
    row = (sb.table("courses")
           .select("id, name, term")
           .eq("id", course_id)
           .single()
           .execute()).data
    return row

@app.post("/upload/pdf")
async def upload_pdf_endpoint(
    course_id: str = Form(...),
    file: UploadFile = File(...),
    owner_id: Optional[str] = Form(None),
    x_user_id: Optional[str] = Header(default=None)
):
    owner = get_owner_id(x_user_id, owner_id)

    # Content-type check
    if file.content_type not in ("application/pdf", "application/x-pdf"):
        raise HTTPException(status_code=415, detail="Only PDF files are allowed.")
    
    # Read bytes
    content = await file.read()

    # Size check )
    if len(content) > MAX_PDF_MB * 1024 * 1024:
        raise HTTPException(
            status_code=413,
            detail=f"PDF too large (> {MAX_PDF_MB} MB)."
        )
    
    # Bytes check 
    if not content.lstrip().startswith(b"%PDF-"):
        raise HTTPException(status_code=400, detail="Uploaded file is not a valid PDF.")
    
    # Save to temp file
    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        tmp.write(content)
        tmp_path = tmp.name
    
    # Hand off to ingestion pipeline
    try:
        ingest_pdf(owner, course_id, tmp_path)
        return{"ok": True, "course_id": course_id, "filename": file.filename}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF ingestion failed: {e}")
    

@app.post("/upload/image")
async def upload_image_endpoint(
    course_id: str = Form(...),
    file: UploadFile = File(...),
    owner_id: Optional[str] = Form(None),
    x_user_id: Optional[str] = Header(default=None)
):
    owner = get_owner_id(x_user_id, owner_id)

    # Persist upload to temp and ingest
    # (image_parser normalizes to PNG internally)
    suffix = os.path.splitext(file.filename)[1] or ".png"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name
    
    try:
        out = ingest_image(owner, course_id, tmp_path)
        return {"ok": True, "course_id": course_id, "filename": file.filename, "result": out}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Image ingestion failed: {e}")
    

@app.post("/chat/ask", response_model=ChatOut)
def chat_ask(payload: ChatIn, x_user_id: Optional[str] = Header(default=None)):
    try:
        res = answer_question(
            course_id=payload.course_id,
            question=payload.question,
            assistance_level=payload.assistance_level,
            mode=payload.mode,
            k=payload.k
        )
        return res
    except Exception as e:
        traceback.print_exc()  # prints full stack in the server console
        raise HTTPException(status_code=500, detail=f"Chat failed: {type(e).__name__}: {e}")

@app.get("/search/preview")
def search_preview(course_id: str, q: str, k: int = 6):
    # Debug helper to preview top hits from rag
    from rag import retrieve_vector
    try:
        hits = retrieve_vector(course_id, q, k)
        return {"ok": True, "hits": hits}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {e}")

@app.get("/whoami")
def whoami():
    import os
    return {"svc_file": __file__, "cwd": os.getcwd(),
            "routes": [r.path for r in app.routes]}
