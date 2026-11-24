export interface TrainingMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface TrainingRecord { messages: TrainingMessage[] }
export const TEST_DATA_LABEL: string;
export function looksSensitive(text: unknown): boolean;
export function validateTrainingRecord(record: unknown): string[];
export function isTestData(record: unknown): boolean;
export function conversationToTrainingRecord(conversation: unknown, persona?: string): { record: TrainingRecord | null; reason: string | null };
export function mergeTrainingRecords(records: unknown[], options?: { includeTestData?: boolean }): { kept: TrainingRecord[]; rejected: Array<{ position: number; reason: string }> };
export function toJsonl(records: unknown[]): string;
