# GUI Grounding with Multi-Turn Self-Correction

A framework for **GUI grounding** — predicting exact pixel coordinates of UI elements from screenshots and natural language descriptions. Includes a VS Code extension for training data generation, and a multi-turn evaluation harness that supports self-correction via visual feedback.

## Overview

```
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
│  Data Generation │──────►│   Model Training │──────►│    Evaluation    │
│  (VS Code ext.)  │       │  (Fine-tuning)   │       │  (Multi-turn)   │
└──────────────────┘       └──────────────────┘       └──────────────────┘
```

1. **Data Generation** — A VS Code extension collects pixel-level cursor coordinates from the Monaco editor, producing JSONL ground-truth data mapping `(line, column)` → `(pixel_x, pixel_y)`.
2. **Training** — Fine-tune vision-language models using the generated data (supports PyTorch, Transformers, TRL, PEFT, DeepSpeed).
3. **Evaluation** — Evaluate models on GUI element localization with multi-turn self-correction: if a prediction is wrong, a red cross is drawn on the screenshot and the model gets another attempt.

## Repository Structure

```
├── conda_env.yaml                 # Conda environment for training
├── data_generation/
│   └── vscode/                    # VS Code extension for data collection
│       ├── src/
│       │   ├── extension.ts       # Extension entry point
│       │   ├── bridge-server.ts   # WebSocket bridge (extension ↔ renderer)
│       │   ├── collector.ts       # Iterates characters, records pixel positions
│       │   ├── injector.ts        # Injects/removes DOM payload into VS Code
│       │   └── dom-payload.js     # Reads cursor coordinates from the DOM
│       ├── package.json
│       └── README.md              # Detailed extension documentation
├── eval/
│   └── test_allturns_api.py       # Multi-turn grounding evaluation script
└── README.md
```

## Getting Started

### Prerequisites

- Python 3.10+
- Node.js and npm (for the VS Code extension)
- VS Code / VS Code Insiders 1.85.0+

### Environment Setup

```bash
# Create the conda environment for training/evaluation
conda env create -f conda_env.yaml
conda activate gta1-7b-gpu-training

# Install additional Python dependencies for evaluation
pip install openai anthropic python-dotenv Pillow
```

### Data Generation (VS Code Extension)

The extension collects exact pixel coordinates of the text cursor as it traverses every character in a file.

```bash
cd data_generation/vscode
npm install
npm run compile
```

See [data_generation/vscode/README.md](data_generation/vscode/README.md) for detailed setup and usage instructions.

### Dataset

Dataset is available and is in the following structure

```
dataset
├── images                      # Visual state screenshots of the scenarios
├── cursor_dark                 # Instructions for Cursor Dark
├── cursor_light                # Instructions for Cursor Light
├── vscode_dark                 # Instructions for Vscode Dark
├── vscode_light                # Instructions for Vscode Light
```


## Evaluation

The evaluation script (`eval/test_allturns_api.py`) runs multi-turn grounding evaluation against API providers. On each turn, if the model's prediction is incorrect, a **red cross** is drawn at the predicted location on the screenshot and the model is prompted to self-correct.

### Supported Providers

| Provider | Flag | Models |
|---|---|---|
| Azure OpenAI | `--provider openai` | GPT-series |
| Anthropic Claude (OpenAI-compat) | `--provider claude46` | Claude Opus 4.6 |
| Qwen (local/remote) | `--provider qwen` | Qwen3.5-9B-A3B, etc. |

### Configuration

Create a `.env` file with your API credentials:

```env
# Azure OpenAI
AZURE_ENDPOINT=https://your-endpoint.openai.azure.com/
AZURE_API_KEY=your-key
DEPLOYMENT_NAME=your-deployment

# Anthropic Claude
CLAUDE_ENDPOINT=https://your-endpoint
CLAUDE_API_KEY=your-key

# Qwen (local vLLM server)
QWEN_BASE_URL=http://127.0.0.1:8010/v1
QWEN_MODEL=Qwen3.5-9B-A3B
```

### Running Evaluation

```bash
# Basic evaluation with Chain-of-Thought prompting (5 turns)
python eval/test_allturns_api.py \
    --provider openai \
    --jsonl path/to/eval_data.jsonl \
    --turns 5 \
    --prompt-variant baseline_cot \
    --verbose

# Evaluate with Claude and save red-cross images
python eval/test_allturns_api.py \
    --provider claude \
    --jsonl path/to/eval_data.jsonl \
    --turns 3 \
    --save-dots-dir ./debug_images \
    --output results.json

# Local Qwen model evaluation
python eval/test_allturns_api.py \
    --provider qwen \
    --jsonl path/to/eval_data.jsonl \
    --limit 100
```

### CLI Options

| Flag | Description | Default |
|---|---|---|
| `--provider`, `-p` | API provider (`openai`, `claude`, `claude46`, `qwen`) | `openai` |
| `--jsonl`, `-j` | Path to JSONL evaluation file | *(required)* |
| `--turns`, `-t` | Max self-correction turns per sample | `5` |
| `--prompt-variant` | System prompt strategy | `baseline_cot` |
| `--feedback-variant` | Feedback message style (`baseline`, `spatial`) | `spatial` |
| `--limit`, `-l` | Max samples to evaluate | all |
| `--max-tokens` | Max output tokens per turn | `4096` |
| `--image-root` | Root directory for resolving image paths | JSONL dir |
| `--save-dots-dir` | Save annotated images with red crosses | — |
| `--output`, `-o` | Output JSON file path | auto-named |
| `--verbose`, `-v` | Print per-sample results | off |

### Prompt Variants

| Variant | Description |
|---|---|
| `baseline` | Direct coordinate prediction |
| `baseline_cot` | Chain-of-thought reasoning before prediction |
| `cursor_aware` | Specialized for text cursor localization |
| `step_by_step` | Structured step-by-step reasoning |
| `visual_anchor` | Uses nearby visual landmarks for precision |
| `minimal` | Concise prompt with minimal instructions |
| `custom` | User-defined prompt template |

### Evaluation Data Format

The evaluation JSONL file should have one sample per line:

```json
{
  "image": "relative/path/to/screenshot.png",
  "bbox": [x0, y0, x1, y1],
  "conversations": [
    {"from": "human", "value": "Click on the 'Save' button"}
  ]
}
```

- `bbox` — Bounding box coordinates (normalized to 1000×1000 scale)
- `image` — Path to the screenshot (relative to JSONL file or `--image-root`)

### Output Metrics

The evaluation reports per-turn:

- **Accuracy** — Fraction of predictions inside the ground-truth bounding box
- **Avg Distance (bbox)** — Mean pixel distance to the nearest bbox edge (for misses)
- **Avg Distance (center)** — Mean pixel distance to the bbox center (for misses)
- **Any-turn hit rate** — Fraction of samples correct on any turn
- **Correction rate** — Fraction that missed on Turn 1 but self-corrected later

## License

See [LICENSE](LICENSE) for details.
