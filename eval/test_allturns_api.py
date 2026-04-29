# Copyright (c) Microsoft. All rights reserved.

"""
All-turns multi-turn grounding evaluation via API providers (OpenAI, Claude, Qwen).

Reports per-turn accuracy, distance, and self-correction improvement.
"""

import argparse
import base64
import json
import math
import os
import re
from io import BytesIO
from typing import Any, Dict, List, Tuple

import openai
from openai import AzureOpenAI
from anthropic import AnthropicFoundry
from dotenv import load_dotenv
from PIL import Image, ImageDraw

load_dotenv()

# ---------------------------------------------------------------------------
# Config (from environment / .env)
# ---------------------------------------------------------------------------
AZURE_ENDPOINT = os.getenv("AZURE_ENDPOINT", "")
API_KEY = os.getenv("AZURE_API_KEY", "")
DEPLOYMENT_NAME = os.getenv("DEPLOYMENT_NAME", "gpt-5.4")
API_VERSION = os.getenv("API_VERSION", "2024-12-01-preview")

CLAUDE_ENDPOINT = os.getenv("CLAUDE_ENDPOINT", "")
CLAUDE_API_KEY = os.getenv("CLAUDE_API_KEY", "")
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-opus-4-5")

CLAUDE46_ENDPOINT = os.getenv("CLAUDE46_ENDPOINT", "")
CLAUDE46_API_KEY = os.getenv("CLAUDE46_API_KEY", os.getenv("GITHUB_COPILOT_TOKEN", ""))
CLAUDE46_MODEL = os.getenv("CLAUDE46_MODEL", "claude-opus-4.6")

QWEN_BASE_URL = os.getenv("QWEN_BASE_URL", "http://127.0.0.1:8010/v1")
QWEN_MODEL = os.getenv("QWEN_MODEL", "Qwen3.5-9B-A3B")
QWEN_ENABLE_THINKING = False

# ---------------------------------------------------------------------------
# Prompt variants
# ---------------------------------------------------------------------------
SYSTEM_PROMPTS = {
    "baseline": """You are an expert UI element locator. Given a GUI image and a user's element description, provide the coordinates of the specified element as a single (x,y) point. The image resolution is height {height} and width {width}. For elements with area, return the center point.

If your previous attempt was incorrect, the image will contain a red cross marking your last predicted coordinate. Use this visual cue to adjust your prediction.

You MUST end your response with the actual numeric coordinate pair on the last line, e.g.:
(310,475)
Do NOT output the literal text "(x,y)" — always substitute real pixel values.""",

    "baseline_cot": """You are an expert UI element locator. Given a GUI image and a user's element description, provide the coordinates of the specified element as a single (x,y) point. The image resolution is height {height} and width {width}. For elements with area, return the center point.

Before answering, reason step by step:
1. Describe what you see in the relevant area of the screenshot
2. Identify the specific UI element or text described in the instruction
3. Narrow down the region where the target is located
4. Estimate the precise pixel coordinates of the target

If your previous attempt was incorrect, the image will contain a red cross marking your last predicted coordinate. Use this visual cue to adjust your prediction — explain how the red cross relates to the target before giving your new answer.

You MUST end your response with the actual numeric coordinate pair on the last line, e.g.:
(310,475)
Do NOT output the literal text "(x,y)" — always substitute real pixel values.""",

    "cursor_aware": """You are a precision GUI text cursor locator. Given a screenshot and a description of where to place a text cursor, provide the exact pixel coordinates of the cursor insertion point.

Key principles:
- Text in GUIs uses fonts where each character occupies a specific pixel range
- A cursor position "before character X" means the left edge of that character's bounding box
- A cursor position "between X and Y" means the pixel boundary between those two characters
- The y-coordinate should be the vertical center of the text line
- Coordinates are in pixels with (0,0) at the top-left corner

Image resolution: height {height}, width {width}.

If your previous attempt was incorrect, the image will contain a red cross marking your last predicted coordinate. Use this visual cue to adjust your prediction.

You may reason about the position, but you MUST end your response with the actual numeric coordinate pair on the last line, e.g.:
(310,475)
Do NOT output the literal text "(x,y)" — always substitute real pixel values.""",

    "step_by_step": """You are a precision cursor placement specialist. Given a screenshot and an instruction describing where to place a text cursor, determine the exact pixel coordinates.

Think through these steps before answering:
1. Identify the text area and locate the specific line mentioned
2. Find the word or character sequence referenced in the instruction
3. Determine the exact character boundary described (e.g., "before the 'o'" means the left edge of 'o')
4. Estimate the pixel coordinate at that boundary — x is the horizontal position, y is the vertical center of the text line

Coordinates use (0,0) at top-left. Image resolution: height {height}, width {width}.

If your previous attempt was incorrect, the image will contain a red cross marking your last predicted coordinate. Adjust accordingly.

You may reason about the position, but you MUST end your response with the actual numeric coordinate pair on the last line, e.g.:
(310,475)
Do NOT output the literal text "(x,y)" — always substitute real pixel values.""",

    "minimal": """Locate the exact pixel position described below in this {width}x{height} screenshot. The target is a text cursor insertion point between specific characters. Coordinates use (0,0) at top-left.

If a red cross is visible, it marks a previous incorrect prediction — adjust your answer.

You MUST end your response with the actual numeric coordinate pair on the last line, e.g.:
(310,475)
Do NOT output the literal text "(x,y)" — always substitute real pixel values.""",

    "visual_anchor": """You are a pixel-precise text cursor locator. Given a screenshot and a cursor placement instruction, output the exact (x,y) pixel coordinates.

Strategy for accuracy:
- First scan vertically to find the correct line
- Then scan horizontally to find the referenced text
- Character boundaries are the thin vertical gaps between adjacent characters
- Use nearby distinctive characters (brackets, operators, capitals) as visual anchors to gauge position
- The y-coordinate should be at the vertical midpoint of the text line

Coordinates use (0,0) at top-left. Image resolution: height {height}, width {width}.

If your previous attempt was incorrect, the image will contain a red cross at your last prediction. Study its position relative to the target and correct.
You may reason about the position, but you MUST end your response with the actual numeric coordinate pair on the last line, e.g.:
(310,475)
Do NOT output the literal text "(x,y)" — always substitute real pixel values.""",

    "custom": """PUT YOUR CUSTOM PROMPT HERE.

Image resolution: height {height}, width {width}.
Output exactly one coordinate pair with real numeric values, e.g.: (310,475)""",
}

FEEDBACK_TEMPLATES = {
    "baseline": (
        "Your previous prediction was ({cross_x},{cross_y}), "
        "shown as a red cross on the image. This was not correct. "
        "Please predict the correct coordinate."
    ),
    "spatial": (
        "Your previous prediction ({cross_x},{cross_y}) is marked with a red cross. "
        "Study the red cross position relative to the target described in the original instruction. "
        "Adjust your coordinates to point at the exact character boundary specified."
    ),
}

# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------
RED_CROSS_RADIUS = 10


def extract_coordinates(raw_string: str) -> Tuple[float, float]:
    matches = re.findall(r"\((-?\d*\.?\d+),\s*(-?\d*\.?\d+)\)", raw_string)
    if not matches:
        return -1.0, -1.0
    return float(matches[-1][0]), float(matches[-1][1])


def draw_red_cross(image: Image.Image, x: int, y: int,
                   arm_length: int = RED_CROSS_RADIUS, width: int = 3) -> Image.Image:
    marked = image.copy()
    draw = ImageDraw.Draw(marked)
    draw.line([(x - arm_length, y), (x + arm_length, y)], fill="red", width=width)
    draw.line([(x, y - arm_length), (x, y + arm_length)], fill="red", width=width)
    return marked


def pil_to_base64(image: Image.Image, fmt: str = "PNG") -> str:
    buf = BytesIO()
    image.save(buf, format=fmt)
    b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
    return f"data:image/{fmt.lower()};base64,{b64}"


def is_inside_bbox(x: float, y: float, bbox: List[float],
                   ratio_h: float, ratio_w: float) -> bool:
    bboxes = [bbox] if not isinstance(bbox[0], list) else bbox
    for box in bboxes:
        x0, y0 = float(box[0]) * ratio_w, float(box[1]) * ratio_h
        x1, y1 = float(box[2]) * ratio_w, float(box[3]) * ratio_h
        w, h = abs(x1 - x0), abs(y1 - y0)
        x_ok = abs(x - (x0 + x1) / 2.0) <= 10.0 if w < 1.0 else x0 <= x <= x1
        y_ok = abs(y - (y0 + y1) / 2.0) <= 10.0 if h < 1.0 else y0 <= y <= y1
        if x_ok and y_ok:
            return True
    return False


def distance_to_bbox(x: float, y: float, bbox: List[float],
                     ratio_h: float, ratio_w: float) -> float:
    bboxes = [bbox] if not isinstance(bbox[0], list) else bbox
    min_dist = float("inf")
    for box in bboxes:
        x0, y0 = float(box[0]) * ratio_w, float(box[1]) * ratio_h
        x1, y1 = float(box[2]) * ratio_w, float(box[3]) * ratio_h
        dx = max(x0 - x, 0, x - x1)
        dy = max(y0 - y, 0, y - y1)
        min_dist = min(min_dist, math.hypot(dx, dy))
    return min_dist


def bbox_center(bbox: List[float], ratio_h: float, ratio_w: float) -> Tuple[float, float]:
    box = bbox if not isinstance(bbox[0], list) else bbox[0]
    cx = (float(box[0]) + float(box[2])) / 2.0 * ratio_w
    cy = (float(box[1]) + float(box[3])) / 2.0 * ratio_h
    return cx, cy


# ---------------------------------------------------------------------------
# Model call
# ---------------------------------------------------------------------------
def call_model(client, messages: list, provider: str, max_tokens: int, verbose: bool) -> str:
    if provider == "openai":
        response = client.chat.completions.create(
            model=DEPLOYMENT_NAME,
            messages=messages,
            max_completion_tokens=max_tokens,
        )
        raw_content = response.choices[0].message.content

    elif provider == "qwen":
        kwargs = {
            "model": QWEN_MODEL,
            "messages": messages,
            "max_tokens": max(max_tokens, 4096) if QWEN_ENABLE_THINKING else max_tokens,
            "presence_penalty": 1.5,
            "extra_body": {
                "chat_template_kwargs": {"enable_thinking": QWEN_ENABLE_THINKING},
            },
        }
        if QWEN_ENABLE_THINKING:
            kwargs["temperature"] = 1.0
            kwargs["top_p"] = 0.95
        else:
            kwargs["temperature"] = 0.7
            kwargs["top_p"] = 0.8
            kwargs["extra_body"]["top_k"] = 20
        response = client.chat.completions.create(**kwargs)
        raw_content = response.choices[0].message.content

    elif provider in ("claude", "claude46"):
        claude_model = CLAUDE46_MODEL if provider == "claude46" else CLAUDE_MODEL

        if provider == "claude46":
            # OpenAI-compatible path (GitHub Copilot API)
            response = client.chat.completions.create(
                model=claude_model,
                messages=messages,
                max_tokens=max_tokens,
            )
            raw_content = response.choices[0].message.content
        else:
            # Native Anthropic SDK path
            claude_system = None
            claude_messages = []
            for msg in messages:
                if msg["role"] == "system":
                    claude_system = msg["content"]
                    continue
                if msg["role"] == "assistant":
                    claude_messages.append({"role": "assistant", "content": msg["content"]})
                    continue
                if isinstance(msg["content"], str):
                    claude_messages.append({"role": "user", "content": msg["content"]})
                    continue
                claude_content = []
                for block in msg["content"]:
                    if block.get("type") == "text":
                        claude_content.append({"type": "text", "text": block["text"]})
                    elif block.get("type") == "image_url":
                        url = block["image_url"]["url"]
                        if url.startswith("data:"):
                            header, b64_data = url.split(",", 1)
                            media_type = header.split(":")[1].split(";")[0]
                        else:
                            b64_data = url
                            media_type = "image/png"
                        claude_content.append({
                            "type": "image",
                            "source": {"type": "base64", "media_type": media_type, "data": b64_data},
                        })
                claude_messages.append({"role": "user", "content": claude_content})

            kwargs = {
                "model": claude_model,
                "messages": claude_messages,
                "max_tokens": 20000,
                "thinking": {"type": "enabled", "budget_tokens": 16000},
            }
            if claude_system:
                kwargs["system"] = claude_system
            response = client.messages.create(**kwargs)
            raw_content = next(
                (block.text for block in response.content if getattr(block, "type", None) == "text"),
                str(response.content),
            )

    else:
        raise ValueError(f"Unknown provider: {provider}")

    raw_content = raw_content or ""
    if verbose:
        print(f"  [RAW] {raw_content[:300]}")
    return raw_content


# ---------------------------------------------------------------------------
# Per-sample multi-turn inference
# ---------------------------------------------------------------------------
def evaluate_sample_multiturn(
    client,
    image: Image.Image,
    instruction: str,
    bbox: list,
    system_prompt: str,
    feedback_template: str,
    provider: str,
    num_turns: int,
    max_tokens: int,
    verbose: bool,
    save_dir: str = None,
    sample_id: int = 0,
) -> List[Dict[str, Any]]:
    img_w, img_h = image.width, image.height
    ratio_h = img_h / 1000.0
    ratio_w = img_w / 1000.0

    instruction_clean = instruction.replace("<image>", "")
    image_b64 = pil_to_base64(image)

    messages = [
        {"role": "system", "content": system_prompt.format(height=img_h, width=img_w)},
        {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": image_b64}},
                {"type": "text", "text": instruction_clean},
            ],
        },
    ]

    turn_results = []
    prediction_history = []

    for turn in range(num_turns):
        if verbose:
            print(f"  [Turn {turn+1}] Calling {provider}...")
        output_text = call_model(client, messages, provider, max_tokens, verbose)
        pred_x, pred_y = extract_coordinates(output_text)

        if pred_x == -1.0 and pred_y == -1.0:
            hit = False
            dist = float("inf")
        else:
            hit = is_inside_bbox(pred_x, pred_y, bbox, ratio_h, ratio_w)
            dist = 0.0 if hit else distance_to_bbox(pred_x, pred_y, bbox, ratio_h, ratio_w)

        gt_cx, gt_cy = bbox_center(bbox, ratio_h, ratio_w)
        gt_dist = math.hypot(pred_x - gt_cx, pred_y - gt_cy) if pred_x != -1.0 else float("inf")

        turn_results.append({
            "turn": turn + 1,
            "prediction": [pred_x, pred_y],
            "inside": hit,
            "distance_to_bbox": dist,
            "distance_to_center": gt_dist,
            "raw_output": output_text,
            "parse_failed": pred_x == -1.0 and pred_y == -1.0,
        })

        if turn < num_turns - 1 and not hit:
            cross_x = int(pred_x) if pred_x != -1.0 else img_w // 2
            cross_y = int(pred_y) if pred_y != -1.0 else img_h // 2
            prediction_history.append((turn + 1, cross_x, cross_y))

            marked_image = draw_red_cross(image, cross_x, cross_y)
            if save_dir:
                os.makedirs(save_dir, exist_ok=True)
                marked_image.save(os.path.join(save_dir, f"sample_{sample_id}_turn_{turn+1}.png"))
            marked_b64 = pil_to_base64(marked_image)

            history_lines = ", ".join(f"Turn {t}: ({px},{py})" for t, px, py in prediction_history)
            feedback_text = feedback_template.format(cross_x=cross_x, cross_y=cross_y)

            assistant_reply = f"({int(pred_x)},{int(pred_y)})" if pred_x != -1.0 else "parsing error"
            messages.append({"role": "assistant", "content": assistant_reply})
            messages.append({
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": marked_b64}},
                    {"type": "text", "text": feedback_text},
                ],
            })
        elif hit:
            break

    return turn_results


# ---------------------------------------------------------------------------
# Evaluation loop
# ---------------------------------------------------------------------------
def evaluate_allturns(
    client,
    jsonl_path: str,
    system_prompt: str,
    feedback_template: str,
    provider: str,
    num_turns: int,
    max_tokens: int,
    image_root: str = None,
    limit: int = None,
    verbose: bool = False,
    save_dots_dir: str = None,
) -> Dict[str, Any]:
    base_dir = image_root if image_root else os.path.dirname(jsonl_path)

    per_turn_correct = [0] * num_turns
    per_turn_distances: List[List[float]] = [[] for _ in range(num_turns)]
    per_turn_center_distances: List[List[float]] = [[] for _ in range(num_turns)]
    per_turn_parse_failures = [0] * num_turns
    total = 0
    any_turn_hit_count = 0
    corrected_count = 0
    all_results: List[Dict[str, Any]] = []

    with open(jsonl_path, "r", encoding="utf-8") as f:
        for line_idx, line in enumerate(f):
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue

            image_rel = item.get("image")
            if not image_rel:
                continue
            image_path = os.path.join(base_dir, image_rel)
            if not os.path.exists(image_path):
                if verbose:
                    print(f"[{line_idx}] Skipping: image not found - {image_path}")
                continue

            instruction = None
            for conv in item.get("conversations", []):
                if conv.get("from") == "human":
                    instruction = conv.get("value")
                    break
            if not instruction:
                continue

            bbox = item.get("bbox")
            if not bbox or len(bbox) != 4:
                continue

            try:
                image = Image.open(image_path).convert("RGB")
            except Exception:
                continue

            if verbose:
                print(f"\n{'='*80}")
                print(f"[{line_idx}] {os.path.basename(image_path)}  ({image.width}x{image.height})")
                print(f"[{line_idx}] Instruction: {instruction[:100]}")

            try:
                turn_results = evaluate_sample_multiturn(
                    client=client,
                    image=image,
                    instruction=instruction,
                    bbox=bbox,
                    system_prompt=system_prompt,
                    feedback_template=feedback_template,
                    provider=provider,
                    num_turns=num_turns,
                    max_tokens=max_tokens,
                    verbose=verbose,
                    save_dir=save_dots_dir,
                    sample_id=line_idx,
                )
            except Exception as e:
                print(f"[{line_idx}] API error: {e}")
                continue

            any_hit = False
            first_turn_hit = False
            for t_result in turn_results:
                t_idx = t_result["turn"] - 1
                if t_result["inside"]:
                    per_turn_correct[t_idx] += 1
                    any_hit = True
                    if t_idx == 0:
                        first_turn_hit = True
                    for remaining in range(t_idx + 1, num_turns):
                        per_turn_correct[remaining] += 1
                    break
                else:
                    per_turn_distances[t_idx].append(t_result["distance_to_bbox"])
                    per_turn_center_distances[t_idx].append(t_result["distance_to_center"])
                    if t_result["parse_failed"]:
                        per_turn_parse_failures[t_idx] += 1

            if not any_hit:
                last_t_idx = len(turn_results) - 1
                for remaining in range(last_t_idx + 1, num_turns):
                    last = turn_results[-1]
                    per_turn_distances[remaining].append(last["distance_to_bbox"])
                    per_turn_center_distances[remaining].append(last["distance_to_center"])

            if any_hit:
                any_turn_hit_count += 1
            if any_hit and not first_turn_hit:
                corrected_count += 1

            total += 1
            all_results.append({
                "index": line_idx,
                "image": image_path,
                "instruction": instruction,
                "bbox": bbox,
                "turns": turn_results,
                "any_turn_hit": any_hit,
                "corrected": any_hit and not first_turn_hit,
            })

            if verbose:
                for tr in turn_results:
                    status = "HIT" if tr["inside"] else ("PARSE_FAIL" if tr["parse_failed"] else "MISS")
                    px, py = tr["prediction"]
                    print(
                        f"[{line_idx}] Turn {tr['turn']} {status} "
                        f"pred=({px:.0f},{py:.0f}) dist={tr['distance_to_center']:.1f}px"
                    )
                rolling_accs = " | ".join(
                    f"T{t+1}={per_turn_correct[t]/total:.1%}" for t in range(num_turns)
                )
                print(f"  Rolling: {rolling_accs}  (n={total})")

            if limit is not None and total >= limit:
                break

    per_turn_metrics = []
    for t in range(num_turns):
        acc = per_turn_correct[t] / total if total > 0 else 0.0
        dists = per_turn_distances[t]
        cdists = per_turn_center_distances[t]
        per_turn_metrics.append({
            "turn": t + 1,
            "accuracy": acc,
            "correct": per_turn_correct[t],
            "total": total,
            "incorrect": total - per_turn_correct[t],
            "parse_failures": per_turn_parse_failures[t],
            "avg_dist_to_bbox_incorrect": sum(dists) / len(dists) if dists else 0.0,
            "avg_dist_to_center_incorrect": sum(cdists) / len(cdists) if cdists else 0.0,
        })

    return {
        "num_turns": num_turns,
        "total_samples": total,
        "any_turn_hit_count": any_turn_hit_count,
        "any_turn_hit_rate": any_turn_hit_count / total if total > 0 else 0.0,
        "corrected_count": corrected_count,
        "correction_rate": corrected_count / total if total > 0 else 0.0,
        "per_turn_metrics": per_turn_metrics,
        "results": all_results,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="All-turns multi-turn grounding evaluation via API providers"
    )
    parser.add_argument("--provider", "-p", type=str, default="openai",
                        choices=["openai", "claude", "claude46", "qwen"],
                        help="Provider to use (default: openai)")
    parser.add_argument("--prompt-variant", type=str, default="baseline_cot",
                        choices=list(SYSTEM_PROMPTS.keys()),
                        help="System prompt variant (default: baseline_cot)")
    parser.add_argument("--feedback-variant", type=str, default="spatial",
                        choices=list(FEEDBACK_TEMPLATES.keys()),
                        help="Feedback message variant (default: spatial)")
    parser.add_argument("--jsonl", "-j", type=str, required=True,
                        help="JSONL evaluation file")
    parser.add_argument("--turns", "-t", type=int, default=5,
                        help="Max inference turns per sample (default: 5)")
    parser.add_argument("--limit", "-l", type=int, default=None,
                        help="Max samples to evaluate")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Print per-sample results")
    parser.add_argument("--output", "-o", type=str, default=None,
                        help="Save results JSON (default: auto-named)")
    parser.add_argument("--image-root", type=str, default=None,
                        help="Root directory for images")
    parser.add_argument("--max-tokens", type=int, default=4096,
                        help="Max output tokens per turn (default: 4096)")
    parser.add_argument("--save-dots-dir", type=str, default=None,
                        help="Directory to save red-cross images")
    args = parser.parse_args()

    system_prompt = SYSTEM_PROMPTS[args.prompt_variant]
    feedback_template = FEEDBACK_TEMPLATES[args.feedback_variant]

    print(f"Provider:         {args.provider}")
    print(f"Prompt variant:   {args.prompt_variant}")
    print(f"Feedback variant: {args.feedback_variant}")

    # Build client
    if args.provider == "openai":
        client = AzureOpenAI(azure_endpoint=AZURE_ENDPOINT, api_key=API_KEY, api_version=API_VERSION)
        model_name = DEPLOYMENT_NAME
        print(f"OpenAI client ready: {DEPLOYMENT_NAME} @ {AZURE_ENDPOINT}")
    elif args.provider == "claude":
        client = AnthropicFoundry(api_key=CLAUDE_API_KEY, base_url=CLAUDE_ENDPOINT)
        model_name = CLAUDE_MODEL
        print(f"Claude client ready: {CLAUDE_MODEL} @ {CLAUDE_ENDPOINT}")
    elif args.provider == "claude46":
        client = openai.OpenAI(
            base_url=CLAUDE46_ENDPOINT,
            api_key=CLAUDE46_API_KEY,
            default_headers={
                "Copilot-Integration-Id": "copilot-developer-cli",
                "Editor-Version": "ux-test-agent/1.0.0",
                "Editor-Plugin-Version": "ux-test-agent/1.0.0",
                "Copilot-Vision-Request": "true",
                "Openai-Intent": "conversation-edits",
            },
        )
        model_name = CLAUDE46_MODEL
        print(f"Claude 4.6 client ready: {CLAUDE46_MODEL} @ {CLAUDE46_ENDPOINT}")
    elif args.provider == "qwen":
        client = openai.OpenAI(base_url=QWEN_BASE_URL, api_key="EMPTY")
        model_name = QWEN_MODEL
        print(f"Qwen client ready: {QWEN_MODEL} @ {QWEN_BASE_URL}")
    else:
        raise ValueError(f"Unknown provider: {args.provider}")

    print(f"\nEvaluating: {args.jsonl}")
    print(f"Max turns: {args.turns}")
    print("-" * 80)

    summary = evaluate_allturns(
        client=client,
        jsonl_path=args.jsonl,
        system_prompt=system_prompt,
        feedback_template=feedback_template,
        provider=args.provider,
        num_turns=args.turns,
        max_tokens=args.max_tokens,
        image_root=args.image_root,
        limit=args.limit,
        verbose=args.verbose,
        save_dots_dir=args.save_dots_dir,
    )

    total = summary["total_samples"]
    any_rate = summary["any_turn_hit_rate"]
    corr_rate = summary["correction_rate"]

    print("\n" + "=" * 110)
    print(f"ALL-TURNS EVALUATION RESULTS  ({args.provider}: {model_name}  |  prompt={args.prompt_variant}  feedback={args.feedback_variant})")
    print("=" * 110)
    print(f"{'Turn':<6} {'Accuracy':>10} {'Correct':>9} {'Incorrect':>11} {'Parse Fail':>12} {'Avg Dist (bbox)':>17} {'Avg Dist (center)':>19}")
    print("-" * 110)
    for m in summary["per_turn_metrics"]:
        print(
            f"  {m['turn']:<4} {m['accuracy']:>9.4f} {m['correct']:>9} "
            f"{m['incorrect']:>11} {m['parse_failures']:>12} "
            f"{m['avg_dist_to_bbox_incorrect']:>16.2f}px {m['avg_dist_to_center_incorrect']:>18.2f}px"
        )
    print("-" * 110)
    print(f"Total samples:        {total}")
    print(f"Any-turn hit rate:    {any_rate:.4f} ({summary['any_turn_hit_count']}/{total})")
    print(f"Corrected (miss T1 -> hit later): {summary['corrected_count']} ({corr_rate:.4f})")

    if len(summary["per_turn_metrics"]) >= 2 and total > 0:
        t1_acc = summary["per_turn_metrics"][0]["accuracy"]
        tf_acc = summary["per_turn_metrics"][-1]["accuracy"]
        delta = tf_acc - t1_acc
        sign = "+" if delta >= 0 else ""
        print(f"\nAccuracy T1 -> T{args.turns}: {sign}{delta:.4f} ({t1_acc:.4f} -> {tf_acc:.4f})")

    output_path = args.output or f"allturns_eval_{model_name}_{args.prompt_variant}_{total}samples.json"
    per_turn = summary["per_turn_metrics"]
    t1 = per_turn[0] if len(per_turn) > 0 else {}
    t2 = per_turn[1] if len(per_turn) > 1 else {}
    output_data = {
        "provider": args.provider,
        "model": model_name,
        "prompt_variant": args.prompt_variant,
        "feedback_variant": args.feedback_variant,
        "system_prompt": system_prompt,
        "feedback_template": feedback_template,
        "jsonl": args.jsonl,
        "num_turns": args.turns,
        "total_samples": total,
        "any_turn_hit_count": summary["any_turn_hit_count"],
        "any_turn_hit_rate": any_rate,
        "corrected_count": summary["corrected_count"],
        "correction_rate": corr_rate,
        "per_turn_metrics": summary["per_turn_metrics"],
        "turn1_accuracy": t1.get("accuracy"),
        "turn1_avg_dist_bbox": t1.get("avg_dist_to_bbox_incorrect"),
        "turn1_avg_dist_center": t1.get("avg_dist_to_center_incorrect"),
        "turn2_avg_dist_bbox": t2.get("avg_dist_to_bbox_incorrect"),
        "turn2_avg_dist_center": t2.get("avg_dist_to_center_incorrect"),
        "per_turn_metrics": per_turn,
        "results": summary["results"],
    }
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output_data, f, indent=2)
    print(f"\nResults saved to: {output_path}")


if __name__ == "__main__":
    main()
