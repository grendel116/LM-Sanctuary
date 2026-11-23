"""Automatic transmission controller for Sanctuary gear-shifting and 2-strike recovery (zero regex)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from tools.coding_tools import READ_BAND_SCHEMAS, WEB_BAND_SCHEMAS, WRITE_BAND_SCHEMAS

_READ_TOOL_NAMES = frozenset({"list_dir", "read_file", "grep_search"})
_WRITE_TOOL_NAMES = frozenset({"edit_file", "write_file", "run_command", "set_working_folder"})
_WEB_TOOL_NAMES = frozenset({"read_webpage", "web_search", "open_in_browser", "browser_action"})

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


def _is_band_notice(output: str) -> bool:
    return output.startswith(("[Read-Only Band Active]", "[Plan Mode Read-Only Band]", "[2-Strike Read-Only Band]"))


def _is_tool_error(output: str) -> bool:
    if not output or _is_band_notice(output):
        return False
    return output.startswith(("Error:", "[Tool Error]"))


@dataclass
class StrikeTracker:
    """Enforces the 2-Strike Rule across in-process tool calls without regex."""

    counts: dict[str, int] = field(default_factory=dict)
    active_strikes: int = 0
    trip_count: int = 0
    replan_required: bool = False
    halt_tools: bool = False
    tripped_on: str = ""

    @staticmethod
    def _error_signatures(tool_name: str, args: dict[str, Any], output: str) -> tuple[str, str]:
        first_line = ""
        for ln in str(output or "").splitlines():
            s = ln.strip()
            if s:
                first_line = s
                break
        norm_err = "".join(ch for ch in first_line.lower() if not ch.isdigit())[:100]
        sig_key = f"{tool_name}:{norm_err}"
        target_val = str(args.get("path") or args.get("command") or args.get("url") or "")[:80].lower()
        target_key = f"{tool_name}:{target_val}" if target_val else sig_key
        return sig_key, target_key

    def record(self, results: list[tuple[str, dict[str, Any], str]]) -> dict[str, Any]:
        """Record tool results from one iteration and return updated strike state."""
        had_error = False
        had_clean_read = False

        for tool_name, raw_args, raw_out in results:
            args = raw_args if isinstance(raw_args, dict) else {}
            output = str(raw_out or "")
            if _is_tool_error(output):
                had_error = True
                self.active_strikes += 1
                sig_key, target_key = self._error_signatures(tool_name, args, output)
                self.counts[sig_key] = self.counts.get(sig_key, 0) + 1
                if target_key != sig_key:
                    self.counts[target_key] = self.counts.get(target_key, 0) + 1
                if self.counts.get(sig_key, 0) >= 2 or self.counts.get(target_key, 0) >= 2:
                    self.trip_count += 1
                    self.tripped_on = sig_key
                    if self.trip_count == 1:
                        self.replan_required = True
                    else:
                        self.replan_required = False
                        self.halt_tools = True
            elif tool_name in _READ_TOOL_NAMES and not _is_band_notice(output):
                had_clean_read = True

        if self.replan_required and not had_error and had_clean_read:
            self.replan_required = False
            self.counts.clear()
            self.active_strikes = 0

        return {
            "active_strikes": self.active_strikes,
            "trip_count": self.trip_count,
            "replan_required": self.replan_required,
            "halt_tools": self.halt_tools,
            "tripped_on": self.tripped_on,
        }


@dataclass(frozen=True)
class ShiftDecision:
    """Computed transmission gear, cloud tier, engaged tool bands, and directive."""

    gear: str  # "park" | "first" | "second" | "vision"
    cloud_tier: str | None
    phase: str  # "idle" | "planning" | "cruising" | "verifying" | "replanning" | "halted"
    reason: str
    write_disengaged: bool = False
    halt_tools: bool = False
    native_tools: list[dict[str, Any]] | None = None
    directive: str = ""
    engine_load: float = 0.0


class TransmissionController:
    """Monitors prompt throttle, token load, and strikes to select gears & tool bands."""

    def __init__(
        self,
        *,
        utterance: str = "",
        is_plan_turn: bool = False,
        is_proceed_turn: bool = False,
        active_story_mode: bool = False,
        prior_tool_error: bool = False,
        has_active_research: bool = False,
        routing_policy: str = "auto",
    ) -> None:
        self.utterance = (utterance or "").strip()
        self.utterance_lower = self.utterance.lower()
        self.is_plan_turn = bool(is_plan_turn)
        self.is_proceed_turn = bool(is_proceed_turn)
        self.active_story_mode = bool(active_story_mode)
        self.prior_tool_error = bool(prior_tool_error)
        self.has_active_research = bool(has_active_research)
        self.routing_policy = (routing_policy or "auto").strip().lower()

        self.coding_engaged = False
        self.web_engaged = bool(has_active_research)
        self.has_explored_workspace = False
        self.has_mutated_files = False
        self.kickdown = bool(prior_tool_error)
        self.throttle_tier: str | None = None
        self.throttle_reason: str = ""
        self.strike_tracker = StrikeTracker()

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
            or "```" in self.utterance
            or "Traceback (most recent call last)" in self.utterance
        ):
            self.throttle_tier = "deep"
            self.throttle_reason = "complex_topic"
            if self.is_plan_turn or self.is_proceed_turn:
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
        for tool_name, _, output in results:
            if tool_name in _READ_TOOL_NAMES and not _is_tool_error(str(output or "")):
                self.has_explored_workspace = True
                self.coding_engaged = True
            elif tool_name in _WRITE_TOOL_NAMES:
                self.coding_engaged = True
                if not _is_tool_error(str(output or "")) and not _is_band_notice(str(output or "")):
                    self.has_mutated_files = True
            elif tool_name in _WEB_TOOL_NAMES:
                self.web_engaged = True
            elif tool_name == "delegate_coding":
                self.coding_engaged = True
        self.strike_tracker.record(results)

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

        if self.active_story_mode or not cloud_available or self.routing_policy == "local_only":
            return ShiftDecision(
                gear="park",
                cloud_tier=None,
                phase="idle",
                reason="story_or_local_only",
                write_disengaged=self.is_plan_turn,
                engine_load=engine_load,
            )

        if has_vision_attachment and iteration == 1:
            return ShiftDecision(
                gear="vision",
                cloud_tier="vision",
                phase="idle",
                reason="vision_attachment",
                write_disengaged=self.is_plan_turn,
                engine_load=engine_load,
            )

        if self.strike_tracker.halt_tools:
            return ShiftDecision(
                gear="second",
                cloud_tier="deep_plan",
                phase="halted",
                reason="two_strike_halt",
                write_disengaged=True,
                halt_tools=True,
                native_tools=None,
                directive=(
                    "# 2-STRIKE HALT DIRECTIVE\n"
                    f"Repeated tool errors persisted (`{self.strike_tracker.tripped_on}`). "
                    "Tools are disengaged for this final response. Write a concise 2-sentence root-cause hypothesis "
                    "of why the attempts failed and report the exact blocking error to the user without guessing."
                ),
                engine_load=engine_load,
            )

        if self.strike_tracker.replan_required:
            return ShiftDecision(
                gear="second",
                cloud_tier="deep_plan",
                phase="replanning",
                reason="two_strike_replan",
                write_disengaged=True,
                native_tools=list(READ_BAND_SCHEMAS),
                directive=(
                    "# 2-STRIKE RULE — MANDATORY READ-ONLY RE-PLAN\n"
                    f"Two consecutive failures occurred on `{self.strike_tracker.tripped_on}`. "
                    "Write tools (`edit_file`, `write_file`, `run_command`) are disengaged for this step. "
                    "Inspect the relevant file or directory read-only (`read_file`, `grep_search`, `list_dir`), "
                    "form a 2-sentence root-cause hypothesis, and pivot before attempting another edit."
                ),
                engine_load=engine_load,
            )

        if self.is_plan_turn or (self.coding_engaged and not self.has_explored_workspace and not self.is_proceed_turn):
            tools_for_step = (
                list(READ_BAND_SCHEMAS)
                if self.is_plan_turn
                else list(READ_BAND_SCHEMAS) + list(WRITE_BAND_SCHEMAS)
            )
            return ShiftDecision(
                gear="second",
                cloud_tier="deep_plan",
                phase="planning",
                reason="planning_always_deep",
                write_disengaged=self.is_plan_turn,
                native_tools=tools_for_step,
                engine_load=engine_load,
            )

        if self.strike_tracker.active_strikes >= 1 or self.kickdown or iteration >= 4:
            phase = "verifying" if self.has_mutated_files else "cruising"
            tools_for_step = (
                list(READ_BAND_SCHEMAS) + list(WRITE_BAND_SCHEMAS)
                if self.coding_engaged
                else (list(WEB_BAND_SCHEMAS) if self.web_engaged else None)
            )
            directive = ""
            if self.kickdown and not self.coding_engaged:
                directive = (
                    "# HIGH-PRECISION ESCALATION DIRECTIVE\n"
                    "The user is signaling urgency, frustration, or correcting an earlier mistake. "
                    "Drop any prior erroneous assumptions immediately—verify facts directly from retrieved tool outputs "
                    "and deliver a clear, accurate, concrete answer in character."
                )
            return ShiftDecision(
                gear="second",
                cloud_tier="deep_recovery",
                phase=phase,
                reason="strike_or_kickdown",
                write_disengaged=False,
                native_tools=tools_for_step,
                directive=directive,
                engine_load=engine_load,
            )

        if self.coding_engaged or self.is_proceed_turn:
            use_fast_cruise = self.routing_policy == "eco_flash" and engine_load < 0.85
            phase = "verifying" if self.has_mutated_files else "cruising"
            return ShiftDecision(
                gear="first" if use_fast_cruise else "second",
                cloud_tier="fast" if use_fast_cruise else "deep",
                phase=phase,
                reason="coding_cruise",
                write_disengaged=False,
                native_tools=list(READ_BAND_SCHEMAS) + list(WRITE_BAND_SCHEMAS),
                engine_load=engine_load,
            )

        if engine_load >= 0.70 or self.throttle_tier == "deep":
            return ShiftDecision(
                gear="second",
                cloud_tier="deep",
                phase="cruising",
                reason="high_load_or_complex" if engine_load >= 0.70 else (self.throttle_reason or "complex_topic"),
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
                native_tools=list(WEB_BAND_SCHEMAS) if self.web_engaged else None,
                engine_load=engine_load,
            )

        return ShiftDecision(
            gear="park",
            cloud_tier=None,
            phase="idle",
            reason="casual_park",
            engine_load=engine_load,
        )
