# Imports
import os
from dotenv import load_dotenv
from supabase import create_client, Client

# Load environment variables and client
load_dotenv()
url = os.getenv("SUPABASE_URL")
key = os.getenv("SUPABASE_KEY")
supabase: Client = create_client(url, key)

# Insert
ins = supabase.table("notes").insert({"content": "hello from python", "tag": "smoke"}).execute()
print("Inserted:", ins.data)

# Select
sel = supabase.table("notes").select("*").order("created_at", desc=True).limit(5).execute()
print("Latest rows:", sel.data)
