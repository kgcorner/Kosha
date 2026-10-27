/**
 * Shared state machine for data screens:
 * `idle → loading → (success | empty | error)`.
 */
export type LoadState = 'idle' | 'loading' | 'success' | 'empty' | 'error';
