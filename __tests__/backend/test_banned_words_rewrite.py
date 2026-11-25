"""Tests for faithful antithesis and banned-word sentence rewriting."""

from __future__ import annotations

import asyncio
import re
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SANCTUARY_DIR = REPO_ROOT / "sanctuary"
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

from core import banned_words as bw

ORIGINAL = "It wasn't an accident; it was planned by the Army."


class BannedWordsRewriteTests(unittest.TestCase):
    def test_precondition_matches_antithesis_pattern(self):
        self.assertIsNotNone(bw.ANTITHESIS_PATTERN.search(ORIGINAL))

    def _make_fake_llm(self, response: str, recorded_prompts: list[str] | None = None):
        async def _fake(prompt: str, model=None, temperature: float = 0.4, max_tokens: int = 64) -> str:
            if recorded_prompts is not None:
                recorded_prompts.append(prompt)
            return response

        return _fake

    def test_accepts_faithful_affirmed_claim(self):
        fake = self._make_fake_llm("It was planned by the Army.")
        out = asyncio.run(bw._rewrite_single_sentence(ORIGINAL, fake, None, None))
        self.assertEqual(out, "It was planned by the Army.")

    def test_rejects_merged_sentence_with_extra_facts(self):
        fake = self._make_fake_llm("Scientists were scrambling because it was planned by the Army anyway.")
        out = asyncio.run(bw._rewrite_single_sentence(ORIGINAL, fake, None, None))
        self.assertEqual(out, ORIGINAL)

    def test_rejects_truncated_rewrite(self):
        fake = self._make_fake_llm("It was planned by")
        out = asyncio.run(bw._rewrite_single_sentence(ORIGINAL, fake, None, None))
        self.assertEqual(out, ORIGINAL)

    def test_rejects_rewrite_when_contrast_still_present(self):
        fake = self._make_fake_llm("It wasn't an accident; it was planned by the Army.")
        out = asyncio.run(bw._rewrite_single_sentence(ORIGINAL, fake, None, None))
        self.assertEqual(out, ORIGINAL)

    def test_drops_context_for_contrast_only_rewrite(self):
        prompts: list[str] = []
        fake = self._make_fake_llm("It was planned by the Army.", recorded_prompts=prompts)
        ctx = "Scientists tracked the plume. " + ORIGINAL
        out = asyncio.run(bw._rewrite_single_sentence(ORIGINAL, fake, None, None, paragraph_context=ctx))
        self.assertEqual(out, "It was planned by the Army.")
        self.assertEqual(len(prompts), 1)
        self.assertNotIn("Context paragraph", prompts[0])
        self.assertIn("Keep only the affirmed claim", prompts[0])

    def test_banned_word_synonym_still_works(self):
        sentence = "Their lives form a tapestry of struggle."
        banned_re = re.compile(r"\btapestry\b", re.IGNORECASE)
        fake = self._make_fake_llm("Their lives form a fabric of struggle.")
        out = asyncio.run(bw._rewrite_single_sentence(sentence, fake, None, banned_re))
        self.assertEqual(out, "Their lives form a fabric of struggle.")


if __name__ == "__main__":
    unittest.main()
