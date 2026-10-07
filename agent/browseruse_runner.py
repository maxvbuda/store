#!/usr/bin/env python3
"""Run one goal with browser-use (https://github.com/browser-use/browser-use),
locally, on the sidecar's Chromium.

lib/browseruse.js spawns this once per goal. It attaches to the Chromium that
agent/browser_service.py already runs (over its CDP port), so the agent works
in the same logged-in profile you watch in the live view — no second browser,
no cloud.

Config arrives as JSON on stdin (one line):
    {"goal", "brief", "model", "fallback_model", "vision", "cdp_url"}
The OpenRouter keys come from the environment (OPENROUTER_API_KEY,
OPENROUTER_FALLBACK_API_KEY), never the JSON.

Progress goes to stdout as lines prefixed "@@BU " + JSON, so browser-use's
own logging can share the stream:
    {"type": "step", "n", "url", "thought", "actions"}
    {"type": "done", "success", "answer"}
    {"type": "error", "error"}
After the config line, stdin stays open for control: a {"stop": true} line
(or stdin closing, i.e. the Node server went away) stops the agent at the
next step boundary.
"""
import asyncio
import json
import os
import sys
import threading

# Before browser_use is imported: it reads these at import time.
os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")
os.environ.setdefault("BROWSER_USE_CLOUD_SYNC", "false")

from browser_use import Agent, BrowserSession  # noqa: E402
from browser_use.llm.openrouter.chat import ChatOpenRouter  # noqa: E402

# The model calls done with this prefix when a human has to step in; the Node
# side turns it into the needs_human status the UI already knows.
NEEDS_HUMAN = "NEEDS_HUMAN:"

RULES = """
Hard rules for this deployment:
- Never sign in, create accounts, or solve CAPTCHAs / bot checks.
- If a sign-in page, CAPTCHA, or bot check blocks the goal, call done at once
  with success=false and text starting with "%s" followed by what blocked you
  and the URL. The owner will clear it in the live view and rerun the goal.
- Work in the current tab. Do not open new tabs unless the goal needs two
  pages side by side.
""" % NEEDS_HUMAN


def emit(kind, **fields):
    fields["type"] = kind
    sys.stdout.write("@@BU " + json.dumps(fields) + "\n")
    sys.stdout.flush()


def make_llm(model, key_env):
    key = os.environ.get(key_env, "") or os.environ.get("OPENROUTER_API_KEY", "")
    return ChatOpenRouter(model=model, api_key=key, temperature=0.2,
                          http_referer="http://localhost:8787")


async def main():
    cfg = json.loads(sys.stdin.readline() or "{}")
    goal = str(cfg.get("goal", "")).strip()
    if not goal:
        emit("error", error="no goal given")
        return
    if not os.environ.get("OPENROUTER_API_KEY"):
        emit("error", error="OPENROUTER_API_KEY is not set")
        return

    session = BrowserSession(
        cdp_url=cfg.get("cdp_url") or "http://127.0.0.1:9242",
        # The sidecar owns this Chromium; when the run ends, detach and leave
        # it (and your logins) running.
        keep_alive=True,
    )
    fallback = cfg.get("fallback_model")
    agent = Agent(
        task=goal,
        llm=make_llm(cfg.get("model") or "deepseek/deepseek-v4-flash", "OPENROUTER_API_KEY"),
        # Same idea as server.js's free fallback: out of credit -> keep going.
        fallback_llm=make_llm(fallback, "OPENROUTER_FALLBACK_API_KEY") if fallback else None,
        browser_session=session,
        extend_system_message=(str(cfg.get("brief") or "") + "\n" + RULES).strip(),
        # Text-only models reject screenshots outright, so vision follows the
        # model's real input modalities (decided on the Node side).
        use_vision=bool(cfg.get("vision")),
        # The judge is a second model pass per run — cost without a UI to show it.
        use_judge=False,
        # Stop comes over stdin (below); browser-use's own handler would turn
        # signals into an interactive pause prompt.
        enable_signal_handler=False,
    )

    loop = asyncio.get_running_loop()

    def control():
        for line in sys.stdin:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("stop"):
                break
        loop.call_soon_threadsafe(agent.stop)   # a stop line, or EOF

    threading.Thread(target=control, daemon=True).start()

    seen = set()

    async def on_step_end(a):
        h = a.history.history[-1] if a.history.history else None
        # A stop can end the same step twice; report each step once.
        if h is None or len(a.history.history) in seen:
            return
        seen.add(len(a.history.history))
        out = h.model_output
        # No model output = a failed step (bad key, timeout) that browser-use
        # is about to retry. If it never recovers, the final error says why.
        if out is None:
            return
        actions = []
        for act in out.action or []:
            d = act.model_dump(exclude_none=True)
            actions.extend("%s %s" % (k, json.dumps(v)[:160]) for k, v in d.items())
        emit("step", n=a.state.n_steps - 1,
             url=(h.state.url if h.state else "") or "",
             thought=out.next_goal or "", actions=actions)

    try:
        history = await agent.run(max_steps=int(cfg.get("max_steps") or 500),
                                  on_step_end=on_step_end)
    except Exception as e:
        emit("error", error="%s: %s" % (type(e).__name__, str(e)[:400]))
        return
    finally:
        try:
            await agent.close()
        except Exception:
            pass

    if agent.state.stopped:
        emit("done", success=False, stopped=True, answer="")
        return
    answer = history.final_result() or ""
    errors = [e for e in history.errors() if e]
    if not history.is_done() and errors:
        emit("error", error=str(errors[-1])[:400])
        return
    emit("done", success=bool(history.is_successful()), answer=answer)


if __name__ == "__main__":
    asyncio.run(main())
