#!/usr/bin/env python3
import os
import sys
import json
import argparse
from dotenv import load_dotenv

# Ensure we can import from root directory
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from google import genai
from google.genai import types

def verify_api_key():
    load_dotenv()
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print(json.dumps({"error": "GEMINI_API_KEY not found in environment."}))
        sys.exit(1)
    return api_key

def get_gemini_client(api_key):
    return genai.Client(api_key=api_key)

def perform_search(client, query):
    """Uses Google Search Grounding to get highly accurate live web results."""
    try:
        grounding_tool = types.Tool(google_search=types.GoogleSearch())
        config = types.GenerateContentConfig(
            tools=[grounding_tool],
            temperature=0.0
        )
        # We use gemini-2.5-flash as the default for reliable structured parsing/grounding
        model_name = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
        
        response = client.models.generate_content(
            model=model_name,
            contents=f"Perform a detailed web search to find: {query}. List all relevant results with phone numbers, exact addresses, and operating hours.",
            config=config
        )
        
        # Capture the raw grounded text
        search_hits = response.text if response.text else ""
        return search_hits
    except Exception as e:
        return f"Search error: {str(e)}"

def verify_and_parse_results(client, search_hits, location, resource_type):
    """Uses Gemini to parse unstructured search hits into verified JSON and cross-reference them."""
    prompt = f"""
    You are an accuracy-focused assistant. Analyze these raw web search results for '{resource_type}' in '{location}':
    
    RAW SEARCH DATA:
    {search_hits}
    
    Extract the list of resources into a clean JSON array.
    For each resource, you MUST extract:
    1. name: The official name.
    2. phone: The contact phone number (format: (XXX) XXX-XXXX). If not found, write "Not Found".
    3. address: The complete, exact physical address. If not found, write "Not Found".
    4. hours: Operating hours (e.g. Mon-Fri 8 AM - 4 PM). If not found, write "Not Found".
    5. contact_person: Key contact person/manager if mentioned, otherwise "Staff".
    6. instructions: Clear, direct step-by-step instructions on who to call, when to arrive, and what to ask or bring.
    7. accuracy_status: Doublecheck the details against the raw search text. Set to "verified" if the name, address, and phone are explicitly present and consistent. Set to "unverified" if any key detail is missing or seems mismatched.
    
    Rules:
    - Never hallucinate details. If not directly present in the search hits, output "Not Found".
    - Output ONLY valid JSON. No markdown backticks, no comments, no extra text.
    """
    try:
        model_name = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
        config = types.GenerateContentConfig(
            temperature=0.0,
            response_mime_type="application/json"
        )
        response = client.models.generate_content(
            model=model_name,
            contents=prompt,
            config=config
        )
        
        # Clean response text just in case
        clean_text = response.text.strip()
        if clean_text.startswith("```json"):
            clean_text = clean_text[7:]
        if clean_text.endswith("```"):
            clean_text = clean_text[:-3]
        
        return json.loads(clean_text.strip())
    except Exception as e:
        return {"error": f"Failed to parse resources: {str(e)}", "raw_response": getattr(response, 'text', '') if 'response' in locals() else ''}

def main():
    parser = argparse.ArgumentParser(description="Social Resource Crawler with Gemini Grounding & Verification")
    parser.add_argument("--location", required=True, help="City/Location to search (e.g., 'Seattle, WA')")
    parser.add_argument("--type", required=True, help="Resource type to query (e.g., 'day labor', 'food bank', 'clinic', 'meeting')")
    args = parser.parse_args()

    api_key = verify_api_key()
    client = get_gemini_client(api_key)

    # Step 1: Execute primary search
    search_query = f"{args.type} in {args.location} phone number address operating hours contact person"
    search_hits = perform_search(client, search_query)

    # Step 2: Parse and structure
    structured_data = verify_and_parse_results(client, search_hits, args.location, args.type)

    # Step 3: Run secondary verification search for top candidate to ensure accuracy
    if isinstance(structured_data, list) and len(structured_data) > 0:
        top_candidate = structured_data[0]
        if top_candidate.get("name") and top_candidate.get("name") != "Not Found":
            verify_query = f"\"{top_candidate['name']}\" {args.location} official phone number and address validation"
            verify_hits = perform_search(client, verify_query)
            
            # Re-verify the top candidate specifically
            verification_prompt = f"""
            You are a strict data auditor. Review this top resource candidate and the verification search data:
            
            CANDIDATE:
            {json.dumps(top_candidate)}
            
            VERIFICATION SEARCH DATA:
            {verify_hits}
            
            If the verification search data shows a different address, phone number, or operating hours for this business/location, correct the fields.
            Update the 'accuracy_status' field:
            - Set to 'verified' if the details match the official search validation.
            - Set to 'corrected' if you had to change any field to match the official search validation.
            - Set to 'unconfirmed' if the validation search does not confirm the address or phone.
            
            Output the updated JSON object ONLY.
            """
            try:
                model_name = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
                config = types.GenerateContentConfig(
                    temperature=0.0,
                    response_mime_type="application/json"
                )
                v_response = client.models.generate_content(
                    model=model_name,
                    contents=verification_prompt,
                    config=config
                )
                clean_v_text = v_response.text.strip()
                if clean_v_text.startswith("```json"):
                    clean_v_text = clean_v_text[7:]
                if clean_v_text.endswith("```"):
                    clean_v_text = clean_v_text[:-3]
                
                updated_candidate = json.loads(clean_v_text.strip())
                structured_data[0] = updated_candidate
            except Exception:
                pass

    # Print clean JSON output
    print(json.dumps(structured_data, indent=2))

if __name__ == "__main__":
    main()
