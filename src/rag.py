"""RAG (Retrieval-Augmented Generation) module for answering questions using course materials."""

# Imports
import os, math, json, textwrap
from dotenv import load_dotenv
from typing import List, Dict, Any, Optional
from supabase import create_client, Client
import google.generativeai as genai

# Load environment variables
load_dotenv()
url = os.getenv("SUPABASE_URL")
service_key = os.getenv("SUPABASE_SERVER_ROLE_KEY")
google_api_key = os.getenv("GOOGLE_API_KEY")
assert url and service_key and google_api_key, "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / GOOGLE_API_KEY"

# Initialize clients
sb: Client = create_client(url, service_key)
genai.configure(api_key=google_api_key)

# Set levels and modes
LEVELS = {
    "novice":     {"k": 12, "temperature": 0.7, "depth": "high", "tone": "friendly"},
    "exam_prep":  {"k": 10, "temperature": 0.5, "depth": "medium", "tone": "concise"},
    "advanced":   {"k": 6,  "temperature": 0.3, "depth": "high", "tone": "technical"},
}

MODES = {
    "worked":   "Provide a clear, step-by-step worked explanation with formulas.",
    "socratic": "Use a brief, guided style: ask 1-3 leading questions, then give the explanation.",
    "exam":     "Be concise; show method and final answer. Emphasize common pitfalls.",
}

# Set constansts
DIM = 768
MAX_CONTEXT_CHARS = 12000

# Method for gemini model initializtion
def gemini_model(temperature: float):
    return genai.GenerativeModel(
        "models/gemini-2.5-flash",
        system_instruction=textwrap.dedent("""
            You are a course-aligned Professor/TA. Answer using the provided CONTEXT.
            If information is not in the context, say you don't have it and suggest where to look.
            Always include a short Sources section with [n] markers that map to provided context items.
            Prefer the course's conventions and notation if present.
        """).strip(),
        generation_config={
            "temperature": temperature,
        }
    )

# Embedding
def embed_text(text: str) -> List[float]:
    out = genai.embed_content(
        model='models/text-embedding-004',
        content=text,
        output_dimensionality=DIM
    )
    v = out['embedding']
    n = math.sqrt(sum(x*x for x in v)) or 1.0
    return [x/n for x in v]

# Retrieval
def retrieve_vector(course_id: str, query: str, k: int) -> List[Dict[str, Any]]:
    qvec = embed_text(query)
    rows = sb.rpc("search_chunks_rpc", {
        "p_course": course_id,
        "p_qvec": qvec,
        "p_k": k
    }).execute().data or []
    # Coerce score to float if possible
    for r in rows:
        try: r["score"] = float(r["score"])
        except: r["score"] = None
    return rows

def retrieve_hybrid(course_id: str, qtext: str, k: int, alpha: float = 0.7) -> List[Dict[str, Any]]:
    qvec = embed_text(qtext)
    rows = sb.rpc("search_chunks_hybrid_rpc", {
        "p_course": course_id,
        "p_qtext": qtext,
        "p_qvec": qvec,
        "p_k": k,
        "p_alpha": alpha
    }).execute().data or []
    for r in rows:
        try: r["score"] = float(r["score"])
        except: r["score"] = None
    return rows

# Format retrieved chunks into a context with [n] markers so LLMs can cite them
def build_context(hits: List[Dict[str, Any]]) -> str:
    blocks, total = [], 0
    for i, h in enumerate(hits, 1):
        title = h.get("document_title") or "Untitled"
        page  = h.get("page")
        cap   = (h.get("caption") or "").strip()
        text  = (h.get("text") or "").strip()
        header = f"[{i}] {title}" + (f" — p.{page}" if page else "")
        body   = (cap + ("\n" if cap and text else "") + textwrap.shorten(text, 2000, placeholder=" …")).strip()
        block  = f"{header}\n{body}"
        # Stop if context is too large
        if total + len(block) > MAX_CONTEXT_CHARS and i > 1:
            break
        blocks.append(block); total += len(block)
    return "\n\n---\n\n".join(blocks)

# def build_prompt(question: str, assistance_level: str, mode: str, context: str) -> str:
#     # (kept for backward-compat / reference; not used below)
#     lvl   = LEVELS.get(assistance_level, LEVELS["exam_prep"])
#     style = MODES.get(mode, MODES["worked"])
#     role  = f"User level: {assistance_level}. Mode: {mode}. Depth: {lvl['depth']}. Tone: {lvl['tone']}."
#     return textwrap.dedent(f"""
#         {role}
#         {style}

#         QUESTION:
#         {question}

#         CONTEXT (cite with [n]):
#         {context}

#         INSTRUCTIONS:
#         - Use the CONTEXT heavily; if missing, say so.
#         - Keep notation consistent with the course materials.
#         - Show key steps (not every algebra line).
#         - If an image is relevant, refer to it as [n] and summarize its caption.
#         - End with "Sources" listing [n] Title — page (and URL if available).
#     """).strip()

# TL;DR + inline-citation prompt
def build_prompt(question: str, assistance_level: str, mode: str, context: str) -> str:
    lvl   = LEVELS.get(assistance_level, LEVELS["exam_prep"])
    style = MODES.get(mode, MODES["worked"])
    role  = f"User level: {assistance_level}. Mode: {mode}. Depth: {lvl['depth']}. Tone: {lvl['tone']}."
    return textwrap.dedent(f"""
        {role}
        {style}

        Write your answer in Markdown with this structure:
        - Start with **TL;DR**: exactly 1–2 sentences.
        - Then the explanation.
        - Put **[n]** inline right after each sentence or equation that uses a source.
        - End with a **Sources** section listing the [n] you used.

        QUESTION:
        {question}

        CONTEXT (cite with [n]):
        {context}

        INSTRUCTIONS:
        - Use the CONTEXT heavily; if missing, say so.
        - Keep notation consistent with the course materials.
        - Show key steps (not every algebra line).
        - If an image is relevant, refer to it as [n] and summarize its caption.
    """).strip()

# Debug count chucks method
def count_chunks(course_id: str) -> int:
    # quick sanity to ensure you're querying a course that actually has content
    data = sb.table("chunks").select("id", count="exact").eq("course_id", course_id).execute()
    return data.count or 0

# Helpers for image detection, dedup, and stats
def is_image_url(u: Optional[str]) -> bool:
    if not u: return False
    u = u.lower()
    return any(u.endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".gif", ".webp")) or "/images/" in u

def dedupe_sources(hits: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Combine duplicate doc/page hits while preserving which [n] markers referred to them.
    Key = (document_id, page)
    """
    by_key: Dict[tuple, Dict[str, Any]] = {}
    for i, h in enumerate(hits, 1):
        key = (h.get("document_id"), h.get("page"))
        current = {
            "marker": f"[{i}]",
            "title":  h.get("document_title"),
            "url":    h.get("document_url"),
            "page":   h.get("page"),
            "score":  h.get("score"),
            "is_image": is_image_url(h.get("document_url")),
            "doc_id": h.get("document_id"),
            "chunk_id": h.get("id"),
            "caption": h.get("caption"),
        }
        entry = by_key.get(key)
        if entry is None:
            by_key[key] = {
                "markers": [current["marker"]],
                "title": current["title"],
                "url": current["url"],
                "page": current["page"],
                "best_score": current["score"],
                "is_image": current["is_image"],
                "doc_id": current["doc_id"],
                "caption": current["caption"],
            }
        else:
            entry["markers"].append(current["marker"])
            if (current["score"] or -1) > (entry["best_score"] or -1):
                entry["best_score"] = current["score"]
                entry["url"] = current["url"]
                entry["caption"] = current["caption"]
    deduped = list(by_key.values())
    deduped.sort(key=lambda x: (-(x["best_score"] or 0), x["page"] or 10**9))
    return deduped

def context_stats(hits: List[Dict[str, Any]]) -> Dict[str, Any]:
    scores = [h.get("score") for h in hits if isinstance(h.get("score"), (int,float))]
    return {
        "chunks_used": len(hits),
        "docs_used": len({h.get("document_id") for h in hits}),
        "score_max": max(scores) if scores else None,
        "score_min": min(scores) if scores else None,
        "score_mean": (sum(scores)/len(scores)) if scores else None,
    }

# Method for answering a question
def answer_question(
    course_id: str,
    question: str,
    assistance_level: str = "exam_prep",
    mode: str = "worked",
    k: Optional[int] = None
) -> Dict[str, Any]:
    assert course_id, "course_id is required"
    if count_chunks(course_id) == 0:
        return {"answer": "This course has no indexed materials yet.", "sources": []}

    lvl = LEVELS.get(assistance_level, LEVELS["exam_prep"])
    k = k or lvl["k"]

    # Try vector first
    hits = retrieve_vector(course_id, question, k)

    # Fallback to hybrid if nothing (or very weak) comes back
    if not hits:
        hits = retrieve_hybrid(course_id, question, k, alpha=0.7)

    if not hits:
        return {
            "answer": "I couldn't find any course materials matching your query. Try rephrasing or uploading more notes.",
            "sources": []
        }

    context = build_context(hits)
    # switched to v2 prompt (TL;DR + inline citations); original build_prompt remains available.
    prompt  = build_prompt(question, assistance_level, mode, context)
    model   = gemini_model(lvl["temperature"])
    resp    = model.generate_content(prompt)
    answer  = getattr(resp, "text", "") or "Unable to generate an answer."

    # Raw sources in hit order (so [n] lines up with the context blocks)
    sources = [{
        "marker": f"[{i}]",
        "title":  h.get("document_title"),
        "url":    h.get("document_url"),
        "page":   h.get("page"),
        "score":  h.get("score"),
        "caption":h.get("caption"),
        "doc_id": h.get("document_id"),
        "chunk_id": h.get("id"),
        "is_image": is_image_url(h.get("document_url")),
    } for i, h in enumerate(hits, 1)]

    # Nice-to-have for UI: dedupbed sources + context stats
    sources_dedup = dedupe_sources(hits)
    stats = context_stats(hits)

    return {
        "answer": answer,              # markdown you can render directly
        "sources": sources,            # keeps 1:1 with [n] markers
        "sources_dedup": sources_dedup,# combined entries with markers list
        "meta": {
            "assistance_level": assistance_level,
            "mode": mode,
            "retrieval": stats        # chunks/docs used + score summary
        }
    }

# Main function for testing
if __name__ == "__main__":
    COURSE_ID = os.getenv("PDES_COURSE_ID")
    q = "How do Robin boundary conditions affect eigenvalues for a 1D heat equation rod?"
    res = answer_question(COURSE_ID, q, assistance_level="novice", mode="worked")

    print(res["answer"])
    print("\nContext used:",
          f"{res['meta']['retrieval']['chunks_used']} chunks from {res['meta']['retrieval']['docs_used']} docs.",
          f"Top score: {res['meta']['retrieval']['score_max']}")
    print("\nSources (dedupbed):")
    for s in res["sources_dedup"]:
        ms = ", ".join(s["markers"])
        page = f"(p.{s['page']})" if s["page"] else ""
        score = f"score {s['best_score']:.2f}" if isinstance(s["best_score"], (int,float)) else ""
        kind = "🖼️" if s["is_image"] else "📄"
        print(f"{kind} {ms} {s['title']} {page} {score} → {s['url']}")
