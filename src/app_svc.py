# Imports
import os, uuid, json
from dotenv import load_dotenv
from supabase import create_client, Client

# Load environment variables and client
load_dotenv()
url = os.getenv("SUPABASE_URL")
key = os.getenv("SUPABASE_SERVER_ROLE_KEY")
sb: Client = create_client(url, key)

# Simulate a user
owner_id = str(uuid.uuid4())

# Create a course
course_id = sb.rpc("create_course_rpc", {
    "p_name": "Partial Differential Equations",
    "p_term": "Fall 2025",
    "p_owner": owner_id
}).execute().data
print("Course:", course_id)

# Create a document
doc_id = sb.rpc("create_document_rpc", {
    "p_course": course_id,
    "p_title": "Sample Lecture",
    "p_type": "pdf",
    "p_url": None,
    "p_meta": {"week":"5","source":"Lecture 12"},
    "p_owner": owner_id
}).execute().data
print("Document:", doc_id)

# Insert a chunk (dummy vectors for now)
vec_text  = [0.0] * 768
vec_text[0] = 1.0  # just to make it non-zero
vec_image = None

chunk_id = sb.rpc("insert_chunk_rpc", {
    "p_course": course_id,
    "p_doc": doc_id,
    "p_vec_text": vec_text,
    "p_text": "3D plot of heat equation solution; modes decay exponentially over time.",
    "p_caption": "Surface plot of u(x,t) decaying with time.",
    "p_ocr": "u_t = a u_xx",
    "p_meta": {"week":"5","topic":"Heat","source_type":"lecture","difficulty":"intro"},
    "p_page": 12,
    "p_hash": "test-hash-123",
    "p_owner": owner_id
}).execute().data
print("Chunk:", chunk_id)

# Search (course-gated)
results = sb.rpc("search_chunks_rpc", {
    "p_course": course_id,
    "p_qvec": vec_text,
    "p_k": 5
}).execute().data

print("\nSearch Results: (top 1 shown): ")
print(json.dumps(results[:1], indent=2))