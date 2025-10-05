"""Image ingestion and parsing module to database for RAG processing."""

# Imports
import os, io, uuid, math, json, hashlib
from dotenv import load_dotenv
from supabase import create_client
from PIL import Image
import google.generativeai as genai

# Optional HEIC support
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except Exception:
    pass

try:
    import pytesseract
except Exception:
    pytesseract = None

# Load environment variables
load_dotenv()
url = os.getenv("SUPABASE_URL")
service_key = os.getenv("SUPABASE_SERVER_ROLE_KEY")
google_api_key = os.getenv("GOOGLE_API_KEY")
assert url and service_key and google_api_key, "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / GOOGLE_API_KEY"



BUCKET = "documents"
DIM = 768
USE_OCR = (pytesseract is not None)

# Initialize clients
sb = create_client(url, service_key)
genai.configure(api_key=google_api_key)
gmodel = genai.GenerativeModel(
    "models/gemini-2.5-flash",
    generation_config={"response_mime_type": "application/json"}
)


# Function for create teh bucket if it doesn't exist
def ensure_bucket(name: str, public: bool = True):
    buckets = sb.storage.list_buckets()
    names = []
    for b in buckets:
        nm = getattr(b, "name", None)
        if nm is None:
            try:
                nm = b["name"]
            except Exception:
                nm = None
        if nm:
            names.append(nm)
    if name not in names:
        sb.storage.create_bucket(name, options={"public": public})

# Function to embed text
def embed_text(text:str) -> list[float]:
    out = genai.embed_content(
        model='models/text-embedding-004',
        content=text,
        output_dimensionality=DIM
    )
    v = out['embedding']
    n = math.sqrt(sum(x*x for x in v)) or 1.0
    return [x/n for x in v]

# Function to create captions and tags for images
# Returns {caption: str, keywords: [], topic: str}
def caption_and_tags(img_bytes: bytes) -> dict:
    prompt = (
        "You are an expert assistant in image recognition and description for a school study-based RAG. "
        "Given an image, describe it in one precise sentence for retrieval. "
        'Return ONLY JSON (no prose). Schema:\n'
        '{ "caption": string, "keywords": string[], "topic": string }\n'
        'caption: one precise sentence for retrieval.\n'
        'keywords: 3-6 short domain terms.\n'
        'topic: short course-topic like "Heat Equation".'
    )
    part = {"mime_type": "image/png", "data": img_bytes}
    resp = gmodel.generate_content([part, prompt])
    txt = getattr(resp, "text", "") or ""
    try:
        data = json.loads(txt)
    except Exception:
        data = {}

    cap = (data.get("caption") or "").strip() or "(image)"
    kws = data.get("keywords") or []
    if not isinstance(kws, list):
        kws = []
    kws = [str(k)[:40] for k in kws[:6]]
    top = (data.get("topic") or "").strip()

    return {"caption": cap, "keywords": kws, "topic": top}

# Function for OCR
def do_ocr(img: Image.Image) -> str | None:
    if not USE_OCR:
        return None
    w, h = img.size
    if max(w, h) < 1200:
        scale = 1200 / max(w, h)
        img = img.resize((int(w*scale), int(h*scale)))
    return pytesseract.image_to_string(img)

# Function for content hash
def content_hash(*parts: str) -> str:
    norm = ' '.join((p or "").strip() for p in parts)
    norm = ' '.join(norm.split())
    return hashlib.sha1(norm.encode('utf-8')).hexdigest()

# Function for image upload
def upload_image(owner_id: str, course_id: str, path: str) -> tuple[str, str, str]:
    ensure_bucket(BUCKET, public=True)  # set False for want private + signed URLs
    doc_id = str(uuid.uuid4())
    storage_path = f"owners/{owner_id}/courses/{course_id}/images/{doc_id}.png"

    # Normalize to PNG
    img = Image.open(path).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    png_bytes = buf.getvalue()

    sb.storage.from_(BUCKET).upload(storage_path, png_bytes, {"content-type": "image/png"})
    url = sb.storage.from_(BUCKET).get_public_url(storage_path)
    # If keeping the bucket private, use:
    # url = sb.storage.from_(BUCKET).create_signed_url(storage_path, 60*60*24)["signedURL"]

    # Add source_type to document meta (optional but useful)
    doc_row = sb.rpc("create_document_rpc", {
        "p_course": course_id,
        "p_title": os.path.basename(path),
        "p_type": "image",
        "p_url": url,
        "p_meta": {"path": storage_path, "source_type": "image"},
        "p_owner": owner_id
    }).execute().data

    return doc_row, url, storage_path

# Function to ingest image
def ingest_image(owner_id: str, course_id: str, image_path: str):
    document_id, url, storage_path = upload_image(owner_id, course_id, image_path)
    print("Uploaded:", url)

    # PNG bytes for captioning
    img = Image.open(image_path).convert("RGB")
    buf = io.BytesIO(); img.save(buf, format="PNG")
    png_bytes = buf.getvalue()

    # Caption + tags (strict JSON)
    desc = caption_and_tags(png_bytes)
    caption  = desc["caption"]
    keywords = desc["keywords"]
    topic    = desc["topic"]

    # OCR (optional; helpful for handwritten/diagram labels)
    ocr = do_ocr(img)

    # Retrieval string = caption + OCR + topic + keywords
    retrieval_text = " ".join([caption, ocr or "", topic, " ".join(keywords)]).strip() or "(image)"
    vec = embed_text(retrieval_text)

    # Store meta on the chunk
    meta = {"source_type": "image", "keywords": keywords, "topic": topic}

    ch_id = sb.rpc("insert_chunk_rpc", {
        "p_course":    course_id,
        "p_doc":       document_id,
        "p_vec_text":  vec,
        "p_text":      retrieval_text,
        "p_caption":   caption,
        "p_ocr":       ocr,
        "p_meta":      meta,
        "p_page":      None,
        "p_hash":      content_hash(retrieval_text),
        "p_owner":     owner_id
        # "p_vec_image": None  # add image embeddings later if desired; match vector dimension in DB
    }).execute().data

    print("Chunk:", ch_id)
    return {"document_id": document_id, "chunk_id": ch_id, "url": url, "meta": meta}

if __name__ == "__main__":
    owner_id = "11111111-2222-3333-4444-555555555555"
    course_id = sb.rpc("get_or_create_course_rpc", {
    "p_name": "PDE 401",
    "p_term": "Fall 2025",
    "p_owner": owner_id
}).execute().data

    print(ingest_image(owner_id, course_id, "./images/Partial_Differential_Equations_Image.jpeg"))