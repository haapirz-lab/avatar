"""
Akademia AI Avatar — Backend v5
Stack: FastAPI · Groq (LLM) · Edge-TTS · HuggingFace DistilBERT

The backend is the BRAIN. It receives text + persona, asks the LLM for a
single structured "behavior" describing what the avatar should say and do,
translates it, synthesizes voice with a viseme (lip-sync) timeline, and
returns ONE unified JSON the frontend maps directly onto the avatar.

Endpoints:
  GET  /health
  POST /ask          -> full behavior pipeline (reply + emotion + gesture + voice + visemes)
  POST /translate    -> EN<->JA translation only
  POST /voice        -> TTS only (text -> audio + visemes)
  POST /upload-face  -> store a reference face photo
  POST /reset        -> clear conversation memory
  GET  /voices       -> available voices
"""

import os
import re
import json
import base64
import asyncio

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import edge_tts

from openai import OpenAI

# ── LLM config (Groq by default, OpenAI as optional fallback) ───────────────
# Groq exposes an OpenAI-compatible API, so we reuse the official `openai`
# client and simply point it at Groq's base URL with your GROQ_API_KEY.
#
# NEVER hardcode the key. Put it in the .env file:
#   GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxx
#   GROQ_MODEL=llama-3.3-70b-versatile          # optional
#
# If you ever want to switch back to OpenAI, set LLM_PROVIDER=openai and provide
# OPENAI_API_KEY instead.
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "groq").strip().lower()

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_BASE_URL = os.environ.get("GROQ_BASE_URL", "https://api.groq.com/openai/v1")

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

if LLM_PROVIDER == "openai":
    LLM_API_KEY = OPENAI_API_KEY
    LLM_MODEL = OPENAI_MODEL
    LLM_BASE_URL = None  # default OpenAI endpoint
else:  # "groq" (default)
    LLM_PROVIDER = "groq"
    LLM_API_KEY = GROQ_API_KEY
    LLM_MODEL = GROQ_MODEL
    LLM_BASE_URL = GROQ_BASE_URL

llm_client = (
    OpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL)
    if LLM_API_KEY
    else None
)


def ai_available() -> bool:
    return llm_client is not None


# ── Voice catalog ──────────────────────────────────────────────────────────
EN_VOICE = "en-US-JennyNeural"
JA_VOICE = "ja-JP-NanamiNeural"

VOICE_MAP = {
    "en":          EN_VOICE,
    "en-US":       EN_VOICE,
    "en-UG":       EN_VOICE,          # Edge-TTS has no en-UG; fall back to en-US
    "en-US-Jenny": "en-US-JennyNeural",
    "ja":          JA_VOICE,
    "ja-JP":       JA_VOICE,
    "ja-JP-Nanami": "ja-JP-NanamiNeural",
}


def resolve_voice(name: str, culture: str) -> str:
    if name and name in VOICE_MAP:
        return VOICE_MAP[name]
    if name and name.endswith("Neural"):
        return name
    return JA_VOICE if culture == "ja" else EN_VOICE


# ── Personas (the avatar's character) ──────────────────────────────────────
PERSONAS = {
    "Tutor": {
        "name": "Kwame",
        "culture": "en",
        "background": "classroom",
        "voice": "en-US",
        "system": (
            "You are Kwame, a friendly, patient bilingual (English/Japanese) tutor. "
            "Use clear, simple, encouraging language. Keep replies under 4 sentences."
        ),
    },
    "Business": {
        "name": "Amara",
        "culture": "en",
        "background": "office",
        "voice": "en-US",
        "system": (
            "You are Amara, a professional business assistant for bilingual communication. "
            "Be concise, formal and factual. Keep replies under 4 sentences."
        ),
    },
    "Casual": {
        "name": "Yuki",
        "culture": "ja",
        "background": "lounge",
        "voice": "ja-JP",
        "system": (
            "You are Yuki, a warm, casual companion for everyday conversation. "
            "Speak naturally and warmly. Keep replies under 4 sentences."
        ),
    },
}

VALID_EXPRESSIONS = ["neutral", "happy", "sad", "surprised", "thinking", "relaxed"]
VALID_GESTURES = ["idle", "wave", "nod", "shake", "explain", "think", "shrug"]


# ── Sentiment (fallback emotion when AI not available) ─────────────────────
_sentiment_pipeline = None


def get_sentiment_pipeline():
    global _sentiment_pipeline
    if _sentiment_pipeline is None:
        try:
            from transformers import pipeline
            _sentiment_pipeline = pipeline(
                "sentiment-analysis",
                model="distilbert-base-uncased-finetuned-sst-2-english",
            )
            print("Sentiment model loaded.")
        except Exception as e:
            print(f"Sentiment model unavailable: {e}")
            _sentiment_pipeline = "unavailable"
    return _sentiment_pipeline


def sentiment_behavior(text: str) -> dict:
    """Heuristic expression+gesture from text, used when AI doesn't supply one."""
    pipe = get_sentiment_pipeline()
    expression, gesture = "neutral", "explain"
    if pipe not in (None, "unavailable"):
        try:
            r = pipe(text[:512])[0]
            if r["label"] == "POSITIVE":
                expression, gesture = "happy", "nod"
            elif r["label"] == "NEGATIVE":
                expression, gesture = "sad", "shake"
        except Exception as e:
            print(f"Sentiment error: {e}")

    low = text.lower()
    if "?" in text or any(w in low for w in ("why", "how", "what", "explain")):
        expression, gesture = "thinking", "explain"
    if any(w in low for w in ("wow", "amazing", "incredible", "great", "fantastic")):
        expression, gesture = "surprised", "nod"
    if any(w in low for w in ("hello", "hi ", "welcome", "konnichiwa", "こんにちは")):
        gesture = "wave"
    return {"expression": expression, "gesture": gesture}


# ── Language helpers ───────────────────────────────────────────────────────
def is_japanese(text: str) -> bool:
    return bool(re.search(r"[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]", text))


def _strip_fences(raw: str) -> str:
    clean = raw.strip()
    for fence in ("```json", "```"):
        clean = clean.replace(fence, "")
    return clean.strip()


async def openai_chat(messages: list, json_mode: bool = False) -> str:
    """Async wrapper around the (sync) OpenAI-compatible client (Groq/OpenAI)."""
    if not ai_available():
        raise RuntimeError(
            f"No API key set for provider '{LLM_PROVIDER}'. "
            "Set GROQ_API_KEY (or OPENAI_API_KEY) in your .env."
        )
    loop = asyncio.get_event_loop()
    kwargs = {"model": LLM_MODEL, "messages": messages}
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    response = await loop.run_in_executor(
        None, lambda: llm_client.chat.completions.create(**kwargs)
    )
    return response.choices[0].message.content


# ── Translation ────────────────────────────────────────────────────────────
async def translate_to_japanese(text: str) -> dict:
    """Returns { 'japanese': '...', 'romanization': '...' }"""
    if not ai_available():
        return {"japanese": text, "romanization": ""}
    system = (
        "You are an expert English-to-Japanese translator. Preserve meaning and "
        "nuance, use natural polite Japanese (です・ます). Output ONLY JSON with keys "
        '"japanese" and "romanization" (Hepburn romaji).'
    )
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": f'English: "{text}"'},
    ]
    try:
        raw = await openai_chat(messages, json_mode=True)
        data = json.loads(_strip_fences(raw))
        return {
            "japanese": data.get("japanese", text),
            "romanization": data.get("romanization", ""),
        }
    except Exception as e:
        print(f"EN->JA error: {e}")
        return {"japanese": text, "romanization": ""}


async def translate_to_english(text: str) -> str:
    if not ai_available():
        return text
    system = (
        "You are an expert Japanese-to-English translator. Output ONLY the English "
        "translation — no quotes, no markdown, no explanation."
    )
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": f'Japanese: "{text}"'},
    ]
    try:
        return (await openai_chat(messages)).strip().strip('"')
    except Exception as e:
        print(f"JA->EN error: {e}")
        return text


# ── Lip-sync / viseme timeline ─────────────────────────────────────────────
VOWEL_VISEMES = {"a": "aa", "e": "ee", "i": "ih", "o": "oh", "u": "ou"}


def word_to_viseme(word: str) -> str:
    if not word:
        return "sil"
    for ch in word.lower():
        if ch in VOWEL_VISEMES:
            return VOWEL_VISEMES[ch]
    return "aa"


async def generate_tts_with_visemes(text: str, voice: str, output_path: str) -> list:
    """Synthesize speech and build a viseme timeline aligned to word boundaries."""
    timeline = []
    communicate = edge_tts.Communicate(text, voice, boundary="WordBoundary")
    chunks = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            t_ms = chunk["offset"] // 10_000
            timeline.append({"t": t_ms, "v": word_to_viseme(chunk.get("text", ""))})
    with open(output_path, "wb") as f:
        for c in chunks:
            f.write(c)
    if timeline:
        timeline.append({"t": timeline[-1]["t"] + 300, "v": "sil"})
    return timeline


# ── The brain: ask ChatGPT for a structured behavior ───────────────────────
async def think(user_text: str, persona: dict, history: list) -> dict:
    """
    Returns {reply, expression, gesture}. The reply is always English; the
    backend translates it to Japanese afterwards.
    """
    if not ai_available():
        return {
            "reply": f'(offline echo) "{user_text}". Set GROQ_API_KEY to enable the AI.',
            **sentiment_behavior(user_text),
        }

    system = (
        f"{persona['system']}\n\n"
        "You also direct a 3D avatar's body. Reply to the user, then choose one "
        f"facial expression from {VALID_EXPRESSIONS} and one gesture from "
        f"{VALID_GESTURES} that best fit your reply.\n"
        'Output ONLY JSON: {"reply": "<english reply>", '
        '"expression": "<expression>", "gesture": "<gesture>"}'
    )

    messages = [{"role": "system", "content": system}]
    messages.extend(history[-8:])
    messages.append({"role": "user", "content": user_text})

    try:
        raw = await openai_chat(messages, json_mode=True)
        data = json.loads(_strip_fences(raw))
        reply = data.get("reply", "").strip() or "..."
        expression = data.get("expression", "neutral")
        gesture = data.get("gesture", "explain")
        if expression not in VALID_EXPRESSIONS:
            expression = "neutral"
        if gesture not in VALID_GESTURES:
            gesture = "explain"
        return {"reply": reply, "expression": expression, "gesture": gesture}
    except Exception as e:
        print(f"think() error: {e}")
        return {"reply": "Sorry, I had trouble thinking just now.",
                **sentiment_behavior(user_text)}


# ── App setup ──────────────────────────────────────────────────────────────
app = FastAPI(title="Akademia AI Avatar v5")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

conversation_history: list = []

_audio_counter = 0


def next_audio_name(prefix: str) -> str:
    """Unique filenames so the browser never plays a stale cached file."""
    global _audio_counter
    _audio_counter += 1
    return f"{prefix}_{_audio_counter}.mp3"


# ── Request models ─────────────────────────────────────────────────────────
class AskRequest(BaseModel):
    text: str
    persona: str = "Tutor"


class TranslateRequest(BaseModel):
    text: str
    target: str = "ja"  # "ja" or "en"


class VoiceRequest(BaseModel):
    text: str
    voice: str = "en-US"
    culture: str = "en"


# ── Endpoints ──────────────────────────────────────────────────────────────
@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "provider": LLM_PROVIDER,
        "model": LLM_MODEL,
        "ai_enabled": ai_available(),
    }


@app.post("/ask")
async def ask_avatar(request: AskRequest):
    user_text = request.text.strip()
    if not user_text:
        return JSONResponse({"error": "Empty input"}, status_code=400)

    persona = PERSONAS.get(request.persona, PERSONAS["Tutor"])

    # Normalize input to English for the brain.
    user_for_ai = user_text
    if is_japanese(user_text):
        user_for_ai = await translate_to_english(user_text)

    behavior = await think(user_for_ai, persona, conversation_history)
    reply_en = behavior["reply"]

    conversation_history.append({"role": "user", "content": user_for_ai})
    conversation_history.append({"role": "assistant", "content": reply_en})

    translation = await translate_to_japanese(reply_en)
    reply_ja = translation["japanese"]
    romanization = translation["romanization"]

    # Voice + visemes for both tracks.
    en_name = next_audio_name("en")
    ja_name = next_audio_name("ja")
    visemes_en, visemes_ja = [], []
    try:
        visemes_en = await generate_tts_with_visemes(
            reply_en, EN_VOICE, os.path.join("static", en_name))
    except Exception as e:
        print(f"EN TTS error: {e}")
    try:
        visemes_ja = await generate_tts_with_visemes(
            reply_ja, JA_VOICE, os.path.join("static", ja_name))
    except Exception as e:
        print(f"JA TTS error: {e}")

    # Primary track follows the persona's culture.
    primary = "ja" if persona["culture"] == "ja" else "en"

    return {
        "reply": reply_en,
        "translated_reply": reply_ja,
        "romanization": romanization,

        "expression": behavior["expression"],
        "gesture": behavior["gesture"],
        "emotion": behavior["expression"],

        "voice": resolve_voice(persona["voice"], persona["culture"]),
        "background": persona["background"],
        "primary": primary,

        "audio_url_en": f"/static/{en_name}",
        "audio_url_ja": f"/static/{ja_name}",
        "audio_url": f"/static/{ja_name if primary == 'ja' else en_name}",

        "visemes_en": visemes_en,
        "visemes_ja": visemes_ja,
        "visemes": visemes_ja if primary == "ja" else visemes_en,

        "behavior": {
            "expression": behavior["expression"],
            "gesture": behavior["gesture"],
            "background": persona["background"],
        },
    }


@app.post("/translate")
async def translate(request: TranslateRequest):
    text = request.text.strip()
    if not text:
        return JSONResponse({"error": "Empty input"}, status_code=400)
    if request.target == "en":
        return {"text": await translate_to_english(text), "romanization": ""}
    result = await translate_to_japanese(text)
    return {"text": result["japanese"], "romanization": result["romanization"]}


@app.post("/voice")
async def voice(request: VoiceRequest):
    text = request.text.strip()
    if not text:
        return JSONResponse({"error": "Empty input"}, status_code=400)
    voice_name = resolve_voice(request.voice, request.culture)
    name = next_audio_name("voice")
    visemes = []
    try:
        visemes = await generate_tts_with_visemes(
            text, voice_name, os.path.join("static", name))
    except Exception as e:
        return JSONResponse({"error": f"TTS failed: {e}"}, status_code=500)
    return {"audio_url": f"/static/{name}", "visemes": visemes, "voice": voice_name}


@app.post("/upload-face")
async def upload_face(photo: UploadFile = File(...)):
    try:
        contents = await photo.read()
        if not photo.content_type or not photo.content_type.startswith("image/"):
            return JSONResponse({"error": "File must be an image"}, status_code=400)
        ext = photo.filename.rsplit(".", 1)[-1] if "." in photo.filename else "jpg"
        out_path = f"static/face_upload.{ext}"
        with open(out_path, "wb") as f:
            f.write(contents)
        b64 = base64.b64encode(contents).decode("utf-8")
        return {"face_data_url": f"data:{photo.content_type};base64,{b64}", "path": out_path}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/reset")
async def reset_conversation():
    conversation_history.clear()
    return {"status": "cleared"}


@app.get("/voices")
async def list_voices():
    return {"en": EN_VOICE, "ja": JA_VOICE, "map": VOICE_MAP}
