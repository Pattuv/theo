import os
from pathlib import Path
from dotenv import load_dotenv
from groq import Groq


load_dotenv(Path(__file__).resolve().parent.parent.parent.parent / ".env")

# system prompt
system_prompt_path = Path(__file__).parent / "CLASSIFERSYSTEMPROMPT.md"
SYSTEM_PROMPT = system_prompt_path.read_text()

#this is the functoin that contains the groq client
def llmclassifier(user_input: str) -> str:

  client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    
    # Simple one-shot call
  completion = client.chat.completions.create(
    model="llama-3.1-8b-instant", #cheap model for one shot call, no history, extremely low token usage
    messages=[
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_input}
    ],
  )

  output_text = completion.choices[0].message.content.strip()
  print(output_text)
  return output_text


x = input("Enter a prompt: ")
llmclassifier(x)
