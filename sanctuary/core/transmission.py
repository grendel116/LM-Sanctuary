"""Automatic transmission controller for Sanctuary gear-shifting (zero regex)."""

from __future__ import annotations

from dataclasses import dataclass

_COMPANION_TOOL_SKILLS = frozenset({
    "web_browsing",
    "portrait_generation",
    "quest_system",
    "log_journaling",
    "music_discovery",
    "feed_tuning",
})
_STORY_TOOL_SKILLS = frozenset({
    "portrait_generation",
    "log_journaling",
})

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
    """Computed model gear, engaged OpenHands tool band, phase, and turn directive."""

    gear: str  # "local" | "fast" | "deep" | "vision"
    tool_band: str = "none"  # "none" | "companion" | "coding"
    phase: str = "idle"  # "idle" | "planning" | "coding" | "cruising"
    reason: str = ""
    write_disengaged: bool = False
    directive: str = ""
    engine_load: float = 0.0


class TransmissionController:
    """Monitors prompt throttle and token load to select model gear (`local|fast|deep|vision`) and OpenHands `tool_band`."""

    def __init__(
        self,
        *,
        utterance: str = "",
        is_plan_turn: bool = False,
        is_proceed_turn: bool = False,
        active_story_mode: bool = False,
        prior_tool_error: bool = False,
        prior_coding_turn: bool = False,
        has_active_research: bool = False,
        has_active_plan: bool = False,
        routing_policy: str = "auto",
        matched_skills: tuple[str, ...] | list[str] = (),
    ) -> None:
        self.utterance = (utterance or "").strip()
        self.is_plan_turn = bool(is_plan_turn)
        self.is_proceed_turn = bool(is_proceed_turn)
        self.active_story_mode = bool(active_story_mode)
        self.prior_tool_error = bool(prior_tool_error)
        self.prior_coding_turn = bool(prior_coding_turn)
        self.has_active_research = bool(has_active_research)
        self.has_active_plan = bool(has_active_plan)
        self.routing_policy = (routing_policy or "auto").strip().lower()
        self.matched_skills = tuple(str(s).strip() for s in (matched_skills or ()) if str(s).strip())

        self.coding_engaged = False
        self.companion_engaged = any(
            s in (_STORY_TOOL_SKILLS if self.active_story_mode else _COMPANION_TOOL_SKILLS)
            for s in self.matched_skills
        )
        self.web_engaged = bool(has_active_research)
        self.kickdown = bool(prior_tool_error)
        self.throttle_tier: str | None = None
        self.throttle_reason: str = ""

        self._assess_initial_throttle()
        if not self.active_story_mode and "auto_programming" in self.matched_skills:
            self.coding_engaged = True

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
            coding_score = scores.get("coding_intent", 0.0)
            candidates = (
                ("coding_intent", "deep", coding_score),
                ("urgency_or_correction", "deep", scores.get("urgency_or_correction", 0.0)),
                ("complex_topic", "deep", scores.get("complex_topic", 0.0)),
                ("accuracy_or_research", "fast", scores.get("accuracy_or_research", 0.0)),
            )
            best_reason, best_tier, best_score = max(candidates, key=lambda item: item[2])
            if best_score >= 0.42 and (best_score - casual_score) >= 0.08:
                self.throttle_tier = best_tier
                self.throttle_reason = best_reason
                if best_reason == "coding_intent" or (
                    self.prior_coding_turn and best_reason in ("urgency_or_correction", "complex_topic")
                ):
                    self.coding_engaged = True
                    self.throttle_tier = "deep"
                elif best_reason == "urgency_or_correction":
                    self.kickdown = True
                return
            if self.prior_coding_turn:
                is_casual_pivot = casual_score >= 0.48 and (casual_score - coding_score) >= 0.25
                if not is_casual_pivot:
                    self.throttle_tier = "deep"
                    self.throttle_reason = "coding_followup"
                    self.coding_engaged = True
                    return

        if self.has_active_research:
            self.throttle_tier = "fast"
            self.throttle_reason = "accuracy_or_research"

    def shift(
        self,
        *,
        iteration: int = 1,
        estimated_tokens: int,
        local_budget: int,
        has_vision_attachment: bool,
        cloud_available: bool,
        vault_locked: bool = False,
    ) -> ShiftDecision:
        budget = max(1024, int(local_budget or 4096))
        engine_load = round(estimated_tokens / float(budget), 3)

        if self.active_story_mode:
            return ShiftDecision(
                gear="local",
                tool_band="companion" if self.companion_engaged else "none",
                phase="idle",
                reason="story_mode",
                engine_load=engine_load,
            )

        if self.is_plan_turn or self.is_proceed_turn or self.has_active_plan or self.coding_engaged:
            tool_band = "coding"
        elif self.companion_engaged:
            tool_band = "companion"
        else:
            tool_band = "none"

        force_local = (self.routing_policy == "local_only") or (not cloud_available and not vault_locked)

        if tool_band == "coding":
            if force_local:
                gear = "local"
                reason = "local_only" if self.routing_policy == "local_only" else "cloud_unavailable_local"
            elif self.is_plan_turn:
                gear = "deep"
                reason = "plan_architect"
            elif self.routing_policy == "eco_flash":
                gear = "fast"
                reason = "eco_flash"
            elif (self.is_proceed_turn or self.has_active_plan) and not self.prior_tool_error:
                gear = "fast"
                reason = "plan_executor"
            else:
                gear = "deep"
                reason = "kickdown" if self.prior_tool_error else "coding_architect"
            return ShiftDecision(
                gear=gear,
                tool_band="coding",
                phase="planning" if self.is_plan_turn else "coding",
                reason=reason,
                write_disengaged=self.is_plan_turn,
                engine_load=engine_load,
            )

        if force_local:
            return ShiftDecision(
                gear="local",
                tool_band=tool_band,
                phase="idle",
                reason="local_only_or_cloud_unavailable",
                engine_load=engine_load,
            )

        if has_vision_attachment and iteration == 1:
            return ShiftDecision(
                gear="vision",
                tool_band=tool_band,
                phase="idle",
                reason="vision_attachment",
                engine_load=engine_load,
            )

        if self.kickdown:
            return ShiftDecision(
                gear="deep",
                tool_band=tool_band,
                phase="cruising",
                reason="kickdown",
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
                gear="deep",
                tool_band=tool_band,
                phase="cruising",
                reason="high_load_or_complex" if engine_load >= 0.70 else (self.throttle_reason or "complex_topic"),
                directive=(
                    "# DEPTH & ACCURACY DIRECTIVE\n"
                    "This turn involves a complex topic or requires verified factual accuracy. "
                    "Ground your response in concrete evidence, technical specifics, and retrieved tool outputs."
                ),
                engine_load=engine_load,
            )

        if self.throttle_tier == "fast" or self.web_engaged or (tool_band == "companion" and self.routing_policy != "local_only"):
            return ShiftDecision(
                gear="fast",
                tool_band=tool_band,
                phase="cruising",
                reason=self.throttle_reason or ("companion_tools" if tool_band == "companion" else "web_research"),
                engine_load=engine_load,
            )

        return ShiftDecision(
            gear="local",
            tool_band="none",
            phase="idle",
            reason="casual_local",
            engine_load=engine_load,
        )
