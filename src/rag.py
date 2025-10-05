"""RAG (Retrieval-Augmented Generation) module for answering questions using course materials."""

# Imports
import os, math, json, textwrap, re
from dotenv import load_dotenv
from typing import List, Dict, Any, Optional
from supabase import create_client, Client
import google.generativeai as genai
from urllib.parse import urlparse

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
    try:
        rows = sb.rpc("search_chunks_hybrid_rpc", {
            "p_course": course_id,
            "p_qtext": qtext,
            "p_qvec": qvec,
            "p_k": k,
            "p_alpha": alpha
        }).execute().data or []
    except Exception:
        # hybrid RPC not present – just fall back to vector-only
        return []
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
        - For any math symbols, surround them with $...$ for inline or $$...$$ for display.
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

def is_pdf_url(url: str | None) -> bool:
    if not url:
        return False
    path = urlparse(url).path.lower()
    return path.endswith(".pdf")

def with_pdf_page(url: str | None, page: int | None) -> str | None:
    """Attach #page=N to PDF URLs so viewers jump to the right page."""
    if not url or not page or not is_pdf_url(url):
        return url
    # fragments are fine after query strings: ...pdf?<stuff>#page=12
    return f"{url}#page={page}"

def round3(x) -> float | None:
    try:
        return round(float(x), 3)
    except Exception:
        return None

def make_snippet(h: dict, width: int = 220) -> str:
    """Prefer body text; fall back to caption."""
    txt = (h.get("text") or "").strip()
    if not txt:
        txt = (h.get("caption") or "").strip()
    if not txt:
        return ""
    return textwrap.shorten(txt, width=width, placeholder=" …")

def confidence_badge(stats: Dict[str, Any]) -> Dict[str, str]:
    mean = stats.get("score_mean") or 0.0
    if mean >= 0.72:   return {"level": "high",   "label": "High confidence"}
    if mean >= 0.66:   return {"level": "medium", "label": "Medium confidence"}
    return {"level": "low", "label": "Low confidence"}


_cite_rx = re.compile(r"\[(\d{1,3})\]")

def linkify_citations(md: str, sources: list[dict]) -> str:
    """Turn [n] into markdown links using sources[n-1].url (+#page for PDFs)."""
    def _sub(m):
        idx = int(m.group(1)) - 1
        if 0 <= idx < len(sources):
            u = sources[idx].get("url")
            return f"[{m.group(1)}]({u})" if u else m.group(0)
        return m.group(0)
    return _cite_rx.sub(_sub, md)

def prepend_image_callouts(answer_md: str, sources: list[dict]) -> str:
    """If the top sources include an image, surface one at the top for UX."""
    imgs = [s for s in sources if s.get("is_image")]
    if not imgs:
        return answer_md
    top = imgs[0]
    caption = top.get("caption") or "(diagram)"
    line = f"> See {top['marker']}: {caption}"
    return f"{line}\n\n{answer_md}"

def dedupe_sources(hits: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    by_doc: Dict[str, Dict[str, Any]] = {}
    for i, h in enumerate(hits, 1):
        doc_id = h.get("document_id") or f"doc-{i}"
        page   = h.get("page")
        title  = h.get("document_title") or "Untitled"
        url    = h.get("document_url")
        is_img = h.get("is_image") if "is_image" in h else is_image_url(url)
        link   = with_pdf_page(url, page) if (url and not is_img) else url
        sc     = h.get("score")

        if doc_id not in by_doc:
            by_doc[doc_id] = {
                "markers":   [f"[{i}]"],
                "title":     title,
                "url":       link,
                "page":      page,
                "best_score": sc,
                "is_image":  bool(is_img),
                "doc_id":    doc_id,
                "caption":   h.get("caption"),
            }
        else:
            by_doc[doc_id]["markers"].append(f"[{i}]")
            # keep best (max) score
            if sc is not None and (by_doc[doc_id]["best_score"] is None or sc > by_doc[doc_id]["best_score"]):
                by_doc[doc_id]["best_score"] = sc
                by_doc[doc_id]["page"] = page
                by_doc[doc_id]["url"]  = link
                by_doc[doc_id]["caption"] = h.get("caption")

    # round once for stable API
    out = []
    for v in by_doc.values():
        v["best_score"] = round3(v["best_score"])
        out.append(v)
    # sort by best_score desc (None last)
    out.sort(key=lambda x: (-1 if x["best_score"] is None else -x["best_score"], x["title"]))
    return out


def context_stats(hits: List[Dict[str, Any]]) -> Dict[str, Any]:
    scores = [float(h["score"]) for h in hits if isinstance(h.get("score"), (int, float))]
    smax = round3(max(scores)) if scores else None
    smin = round3(min(scores)) if scores else None
    smean = round3(sum(scores)/len(scores)) if scores else None
    docs = len({h.get("document_id") for h in hits})
    return {
        "chunks_used": len(hits),
        "docs_used": docs,
        "score_max": smax,
        "score_min": smin,
        "score_mean": smean,
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

    # 1) Retrieval
    hits = retrieve_vector(course_id, question, k)
    if not hits:
        # fallback to hybrid if available in DB; your retrieve_hybrid already guards
        hits = retrieve_hybrid(course_id, question, k, alpha=0.7)
    if not hits:
        return {
            "answer": "I couldn't find any course materials matching your query. Try rephrasing or uploading more notes.",
            "sources": []
        }

    # 2) Build context + prompt
    context = build_context(hits)
    prompt  = build_prompt(question, assistance_level, mode, context)
    model   = gemini_model(lvl["temperature"])
    resp    = model.generate_content(prompt)
    answer  = getattr(resp, "text", "") or "Unable to generate an answer."

    # 3) Build enriched sources 1:1 with hit order (so [n] aligns)
    sources: List[Dict[str, Any]] = []
    for i, h in enumerate(hits, 1):
        is_img = h.get("is_image") if "is_image" in h else is_image_url(h.get("document_url"))
        url    = h.get("document_url")
        page   = h.get("page")
        link   = with_pdf_page(url, page) if (url and not is_img) else url

        sources.append({
            "marker":   f"[{i}]",
            "title":    h.get("document_title"),
            "url":      link,
            "page":     page,
            "score":    round3(h.get("score")),
            "caption":  h.get("caption"),
            "snippet":  make_snippet(h),  # short preview for your UI
            "doc_id":   h.get("document_id"),
            "chunk_id": h.get("id"),
            "is_image": bool(is_img),
        })

    # 4) Post-process the model output (image callout + clickable [n])
    answer = prepend_image_callouts(answer, sources)
    answer = linkify_citations(answer, sources)

    # 5) Nice-to-have for UI: dedupbed sources + stats + confidence badge
    sources_dedup = dedupe_sources(hits)
    stats         = context_stats(hits)       # expects score_max/min/mean, chunks_used, docs_used, etc.
    conf          = confidence_badge(stats)   # {"level": "high|medium|low", "label": "..."}

    return {
        "answer":        answer,          # markdown ready (with linked [n])
        "sources":       sources,         # 1:1 with [n]
        "sources_dedup": sources_dedup,   # merged entries with markers list
        "meta": {
            "assistance_level": assistance_level,
            "mode": mode,
            "retrieval": stats,
            "confidence": conf
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
