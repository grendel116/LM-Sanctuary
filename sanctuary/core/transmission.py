"""Automatic transmission controller for Sanctuary gear-shifting (zero regex)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from tools.coding_tools import WEB_BAND_SCHEMAS

_WEB_TOOL_NAMES = frozenset({"read_webpage", "web_search", "open_in_browser", "browser_action", "http_probe"})

TURN_SEMANTIC_POLES: dict[str, tuple[str, ...]] = {
    "coding_intent": (
        "Edit this file in the repository, fix the bug in the codebase, and run the unit tests.",
        "Inspect the project directory, search for where this component is implemented, and refactor it.",
        "Add a new feature to the frontend or backend code and verify it builds.",
    ),
    "webpage_followup": (
        "Look at the webpage please.",
        "Read the page and tell me what the documentation says.",
        "Check the link I just shared and analyze the site.",
    ),
    "urgency_or_correction": (
        "That is wrong, it did not work and you are making mistakes!",
        "Look at the webpage please, you did not read it or answer my question.",
        "Stop guessing and making things up, that is incorrect.",
        "I need this fixed ASAP, production is down and this is an urgent emergency.",
        "Why won't you use your tools properly? This is frustrating and broken.",
    ),
    "complex_topic": (
        "Can you compare the distributed system architecture trade-offs and concurrency model here?",
        "Analyze the root cause of this bug, evaluate the algorithm complexity, and design a fix.",
        "Provide an in-depth dialectical and materialist synthesis of the economic and theoretical structure.",
    ),
    "accuracy_or_research": (
        "Please fact check and verify the exact technical details from the documentation.",
        "Explain in detail how this works and summarize the key facts accurately.",
    ),
    "casual": (
        "Hey, how was your evening? How are you feeling tonight?",
        "Good morning! I just made some coffee and wanted to chat for a bit.",
        "What do you think of this? Haha that is pretty funny.",
    ),
}


def score_utterance_pedals(utterance: str) -> dict[str, float]:
    """Score an utterance against cached semantic pole exemplars using local CPU embeddings."""
    clean = " ".join(str(utterance or "").split())[:600]
    if not clean:
        return {}
    try:
        import numpy as np
        from utils.semantic_scorer import _encode_texts

        pole_names = list(TURN_SEMANTIC_POLES.keys())
        pole_texts: list[str] = []
        pole_counts: list[int] = []
        for name in pole_names:
            exemplars = TURN_SEMANTIC_POLES[name]
            pole_counts.append(len(exemplars))
            pole_texts.extend(exemplars)

        vecs = _encode_texts([*pole_texts, clean])
        if not vecs or len(vecs) != len(pole_texts) + 1:
            return {}
        q_vec = vecs[-1]
        scores: dict[str, float] = {}
        cursor = 0
        for name, count in zip(pole_names, pole_counts):
            scores[name] = max(float(np.dot(q_vec, vecs[cursor + i])) for i in range(count))
            cursor += count
        return scores
    except Exception:
        return {}


@dataclass(frozen=True)
class ShiftDecision:
    """Computed transmission gear, cloud tier, engaged tool bands, and directive."""

    gear: str  # "park" | "first" | "second" | "vision" | "openhands"
    cloud_tier: str | None
    phase: str  # "idle" | "planning" | "coding" | "cruising"
    reason: str
    write_disengaged: bool = False
    halt_tools: bool = False
    native_tools: list[dict[str, Any]] | None = None
    directive: str = ""
    engine_load: float = 0.0


class TransmissionController:
    """Monitors prompt throttle and token load to route between Local Park, Cloud Web/Chat, and In-Process OpenHands."""

    def __init__(
        self,
        *,
        utterance: str = "",
        is_plan_turn: bool = False,
        is_proceed_turn: bool = False,
        active_story_mode: bool = False,
        prior_tool_error: bool = False,
        has_active_research: bool = False,
        has_active_plan: bool = False,
        routing_policy: str = "auto",
    ) -> None:
        self.utterance = (utterance or "").strip()
        self.is_plan_turn = bool(is_plan_turn)
        self.is_proceed_turn = bool(is_proceed_turn)
        self.active_story_mode = bool(active_story_mode)
        self.prior_tool_error = bool(prior_tool_error)
        self.has_active_research = bool(has_active_research)
        self.has_active_plan = bool(has_active_plan)
        self.routing_policy = (routing_policy or "auto").strip().lower()

        self.coding_engaged = False
        self.web_engaged = bool(has_active_research)
        self.kickdown = bool(prior_tool_error)
        self.throttle_tier: str | None = None
        self.throttle_reason: str = ""

        self._assess_initial_throttle()

    def _assess_initial_throttle(self) -> None:
        if self.active_story_mode:
            return
        if self.prior_tool_error:
            self.throttle_tier = "deep"
            self.throttle_reason = "prior_tool_error_followup"
            self.kickdown = True
            return

        if (
            self.is_plan_turn
            or self.is_proceed_turn
            or self.has_active_plan
            or "```" in self.utterance
            or "Traceback (most recent call last)" in self.utterance
        ):
            self.throttle_tier = "deep"
            self.throttle_reason = "complex_topic"
            if self.is_plan_turn or self.is_proceed_turn or self.has_active_plan:
                self.coding_engaged = True
            return

        if self.utterance:
            scores = score_utterance_pedals(self.utterance)
            casual_score = scores.get("casual", 0.0)
            candidates = (
                ("coding_intent", "deep", scores.get("coding_intent", 0.0)),
                ("urgency_or_correction", "deep", scores.get("urgency_or_correction", 0.0)),
                ("complex_topic", "deep", scores.get("complex_topic", 0.0)),
                ("accuracy_or_research", "fast", scores.get("accuracy_or_research", 0.0)),
            )
            best_reason, best_tier, best_score = max(candidates, key=lambda item: item[2])
            if best_score >= 0.42 and (best_score - casual_score) >= 0.08:
                self.throttle_tier = best_tier
                self.throttle_reason = best_reason
                if best_reason == "coding_intent":
                    self.coding_engaged = True
                elif best_reason == "urgency_or_correction":
                    self.kickdown = True
                return

        if self.has_active_research:
            self.throttle_tier = "fast"
            self.throttle_reason = "accuracy_or_research"

    def record_tool_results(self, results: list[tuple[str, dict[str, Any], str]]) -> None:
        for tool_name, _, _ in results:
            if tool_name in _WEB_TOOL_NAMES:
                self.web_engaged = True
            elif tool_name == "delegate_coding":
                self.coding_engaged = True

    def shift(
        self,
        *,
        iteration: int,
        estimated_tokens: int,
        local_budget: int,
        has_vision_attachment: bool,
        cloud_available: bool,
    ) -> ShiftDecision:
        budget = max(1024, int(local_budget or 4096))
        engine_load = round(estimated_tokens / float(budget), 3)

        if self.active_story_mode:
            return ShiftDecision(
                gear="park",
                cloud_tier=None,
                phase="idle",
                reason="story_mode",
                engine_load=engine_load,
            )

        if self.is_plan_turn or self.is_proceed_turn or self.has_active_plan or self.coding_engaged:
            tier = (
                "deep_plan"
                if self.is_plan_turn
                else ("fast" if self.routing_policy == "eco_flash" else "deep")
            )
            return ShiftDecision(
                gear="openhands",
                cloud_tier=tier,
                phase="planning" if self.is_plan_turn else "coding",
                reason="openhands_in_process",
                write_disengaged=self.is_plan_turn,
                engine_load=engine_load,
            )

        if not cloud_available or self.routing_policy == "local_only":
            return ShiftDecision(
                gear="park",
                cloud_tier=None,
                phase="idle",
                reason="local_only_or_cloud_unavailable",
                engine_load=engine_load,
            )

        if has_vision_attachment and iteration == 1:
            return ShiftDecision(
                gear="vision",
                cloud_tier="vision",
                phase="idle",
                reason="vision_attachment",
                native_tools=list(WEB_BAND_SCHEMAS),
                engine_load=engine_load,
            )

        if self.kickdown:
            return ShiftDecision(
                gear="second",
                cloud_tier="deep_recovery",
                phase="cruising",
                reason="kickdown",
                native_tools=list(WEB_BAND_SCHEMAS),
                directive=(
                    "# HIGH-PRECISION ESCALATION DIRECTIVE\n"
                    "The user is signaling urgency, frustration, or correcting an earlier mistake. "
                    "Drop any prior erroneous assumptions immediately—verify facts directly from retrieved tool outputs "
                    "and deliver a clear, accurate, concrete answer in character."
                ),
                engine_load=engine_load,
            )

        if engine_load >= 0.70 or self.throttle_tier == "deep":
            return ShiftDecision(
                gear="second",
                cloud_tier="deep",
                phase="cruising",
                reason="high_load_or_complex" if engine_load >= 0.70 else (self.throttle_reason or "complex_topic"),
                native_tools=list(WEB_BAND_SCHEMAS),
                directive=(
                    "# DEPTH & ACCURACY DIRECTIVE\n"
                    "This turn involves a complex topic or requires verified factual accuracy. "
                    "Ground your response in concrete evidence, technical specifics, and retrieved tool outputs."
                ),
                engine_load=engine_load,
            )

        if self.throttle_tier == "fast" or self.web_engaged:
            return ShiftDecision(
                gear="first",
                cloud_tier="fast",
                phase="cruising",
                reason=self.throttle_reason or "web_research",
                native_tools=list(WEB_BAND_SCHEMAS),
                engine_load=engine_load,
            )

        return ShiftDecision(
            gear="park",
            cloud_tier=None,
            phase="idle",
            reason="casual_park",
            engine_load=engine_load,
        )
