
from bs4 import BeautifulSoup
import sys

html_content = sys.argv[1]
soup = BeautifulSoup(html_content, 'html.parser')
text = soup.get_text(separator='\n', strip=True)

print(text)
