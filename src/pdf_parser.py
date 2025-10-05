"""PDF ingestion and parsing module to database for RAG processing."""

# Imports
import os, io, math, uuid
from dotenv import load_dotenv
import fitz
import pytesseract
from PIL import Image
import google.generativeai as genai
from supabase import create_client

# Load environment variables
load_dotenv()
url = os.getenv("SUPABASE_URL")
service_key = os.getenv("SUPABASE_SERVER_ROLE_KEY")
google_api_key = os.getenv("GOOGLE_API_KEY")
BUCKET = "documents"
DIM = 768
USE_OCR = True

# Initialize clients
sb = create_client(url, service_key)
genai.configure(api_key=google_api_key)

# Function for embedding text
def embed(text: str) -> list[float]:
    out = genai.embed_content(
        model='models/text-embedding-004',
        content=text,
        output_dimensionality=DIM
    )
    v = out['embedding']
    n = math.sqrt(sum(x*x for x in v)) or 1.0
    return [x/n for x in v]

# Function for uploading pdfs
def upload_pdf(owner_id: str, course_id: str, pdf_path: str, title=None) -> tuple[str, str]:
    nice_title = title or os.path.splitext(os.path.basename(pdf_path))[0].replace("_"," ")
    doc_id = str(uuid.uuid4())
    storage_path = f"owners/{owner_id}/courses/{course_id}/docs/{doc_id}.pdf"
    with open(pdf_path, "rb") as f:
        sb.storage.from_(BUCKET).upload(storage_path, f.read(), {"content-type": "application/pdf"})
    url = sb.storage.from_(BUCKET).get_public_url(storage_path)
    # create document row
    resp = sb.rpc("create_document_rpc", {
        "p_course": course_id,
        "p_title": nice_title,  # <— use friendly title
        "p_type": "pdf",
        "p_url": url,
        "p_meta": {"original_filename": os.path.basename(pdf_path)},
        "p_owner": owner_id
    }).execute()
    return resp.data, url

# If text is weak and OCR is enabled, run OCR
def page_text_with_ocr(pdf: fitz.Document, page_idx: int) -> tuple[str, str]:
    page = pdf.load_page(page_idx)
    text = page.get_text("text", sort=True)
    ocr_text = None
    if USE_OCR and len(text.strip()) < 30:
        # Rasterize page and OCR it
        pix = page.get_pixmap(dpi=250)
        img = Image.open(io.BytesIO(pix.tobytes("png")))
        ocr_text = pytesseract.image_to_string(img)
    return text, ocr_text

# Function to chunk text
def chunk_text(s: str, size: int = 1200, overlap: int = 200):
    s = ' '.join(s.split())
    chunks = []
    i = 0
    n = len(s)
    while i < n:
        end = min(i + size, n)
        chunk = s[i: end]
        chunks.append(chunk)
        if end == n:
            break
        i = end - overlap
        if i < 0:
            i = 0
    return chunks

# Function to ingest pdfs
def ingest_pdf(owner_id: str, course_id: str, pdf_path: str):
    # Upload and create document
    document_id, url = upload_pdf(owner_id, course_id, pdf_path)
    print("Uploaded:", url)

    # Extract text per page
    pdf = fitz.open(pdf_path)
    for p in range(pdf.page_count):
        raw_text, ocr_text = page_text_with_ocr(pdf, p)
        # Retrieval text = prefer extracted text; if empty, use OCR
        retrieval_text = (raw_text or "") + ("\n" + ocr_text if ocr_text else "")
        if not retrieval_text.strip():
            continue

        # Chunk the text
        for chunk in chunk_text(retrieval_text, size=1200, overlap=200):
            vec = embed(chunk)
            meta = {"page": p+1, "source_type": "pdf"}
            # Insert chunk
            sb.rpc("insert_chunk_rpc", {
                "p_course":    course_id,
                "p_doc":       document_id,
                "p_vec_text":  vec,
                "p_text":      chunk,
                "p_caption":   None,
                "p_ocr":       ocr_text if ocr_text else None,
                "p_meta":      meta,
                "p_page":      p+1,
                "p_owner":     owner_id
            }).execute()
    print("Ingest complete.")

if __name__ == "__main__":
    # EXAMPLE: replace with a real owner (Supabase Auth user id) once you have auth wired
    owner = "11111111-2222-3333-4444-555555555555"
    course = sb.rpc("get_or_create_course_rpc", {
    "p_name": "PDE 401",
    "p_term": "Fall 2025",
    "p_owner": owner
}).execute().data
    ingest_pdf(owner, course, "./pdfs/Partial_Differential_Equations_Textbook.pdf")
