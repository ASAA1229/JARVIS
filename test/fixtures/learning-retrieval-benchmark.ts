/**
 * Synthetic, non-personal benchmark corpus for JARVIS long-term memory retrieval.
 * Version changes must be reviewed alongside expected relevance labels.
 */
export const LEARNING_RETRIEVAL_BENCHMARK_VERSION = '2026-11-13.v1';

export const LEARNING_RETRIEVAL_BENCHMARK = [
  {
    key: 'voice-wake',
    category: 'project',
    content: 'JARVIS voice wake phrase is Hey Jarvis and uses local audio detection.',
    query: 'voice wake phrase',
  },
  {
    key: 'ollama-local',
    category: 'project',
    content: 'Ollama provides local inference using the llama3.2 model.',
    query: 'local Ollama inference',
  },
  {
    key: 'android-enrollment',
    category: 'project',
    content: 'Android companion enrollment uses an Ed25519 device identity.',
    query: 'Android device enrollment identity',
  },
  {
    key: 'workflow-checkpoint',
    category: 'project',
    content: 'Workflow branch execution must respect dependencies and durable checkpoints.',
    query: 'workflow branch dependency checkpoint',
  },
  {
    key: 'pdf-ocr',
    category: 'project',
    content: 'PDF OCR is opt-in and uses local Poppler and Tesseract tools.',
    query: 'PDF OCR Tesseract',
  },
  {
    key: 'memory-deletion',
    category: 'project',
    content: 'Memory deletion purges derived embeddings and version history.',
    query: 'memory deletion embeddings',
  },
  {
    key: 'piper-tts',
    category: 'project',
    content: 'Piper provides local speech synthesis output.',
    query: 'Piper speech synthesis',
  },
  {
    key: 'windows-app',
    category: 'project',
    content: 'Windows application launch verifies process identity and foreground window.',
    query: 'Windows application launch foreground window',
  },
] as const;
