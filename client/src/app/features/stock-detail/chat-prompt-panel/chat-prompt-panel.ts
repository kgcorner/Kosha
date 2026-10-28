import { Component, ElementRef, effect, inject, input, signal, viewChild } from '@angular/core';

import { ApiService } from '../../../core/api';
import { LoadState } from '../../../core/models/load-state';
import { ChatPrompt } from '../../../core/models/stock-analysis';

/**
 * "Copy chat prompt": builds a self-contained Markdown prompt (role, the
 * investor's situation, every data section, what to answer first) so a
 * conversation about this stock can be started in any chat assistant. No model
 * is called; the backend only assembles the same data the AI analysis uses.
 */
@Component({
  selector: 'app-chat-prompt-panel',
  templateUrl: './chat-prompt-panel.html',
  styleUrl: './chat-prompt-panel.scss',
})
export class ChatPromptPanel {
  private readonly api = inject(ApiService);

  readonly stockId = input.required<number>();
  readonly held = input(false);

  protected readonly open = signal(false);
  protected readonly state = signal<LoadState>('idle');
  protected readonly result = signal<ChatPrompt | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal<'idle' | 'done' | 'failed'>('idle');

  private readonly textarea = viewChild<ElementRef<HTMLTextAreaElement>>('promptText');

  /** A prompt built for the other question (buy vs hold/sell) or another stock is discarded. */
  private readonly resetOnChange = effect(() => {
    this.stockId();
    this.held();
    this.result.set(null);
    this.state.set('idle');
    this.copied.set('idle');
    this.open.set(false);
  });

  protected generate(): void {
    this.open.set(true);
    if (this.state() === 'loading') {
      return;
    }
    if (this.result()) {
      return;
    }
    this.state.set('loading');
    this.error.set(null);
    this.api.getChatPrompt(this.stockId(), { held: this.held() }).subscribe({
      next: (result) => {
        this.result.set(result);
        this.state.set('success');
      },
      error: (error: unknown) => {
        this.error.set(
          error instanceof Error && error.message ? error.message : 'Unable to build the prompt.',
        );
        this.state.set('error');
      },
    });
  }

  protected close(): void {
    this.open.set(false);
    this.copied.set('idle');
  }

  protected async copy(): Promise<void> {
    const text = this.result()?.prompt;
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set('done');
      return;
    } catch {
      // Clipboard API unavailable (http, permissions): fall back to selecting the text.
    }
    const area = this.textarea()?.nativeElement;
    if (area) {
      area.focus();
      area.select();
      try {
        this.copied.set(document.execCommand('copy') ? 'done' : 'failed');
        return;
      } catch {
        /* fall through */
      }
    }
    this.copied.set('failed');
  }

  protected download(): void {
    const result = this.result();
    if (!result) {
      return;
    }
    const blob = new Blob([result.prompt], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${slug(result.stock.symbol ?? result.stock.name)}-${result.held ? 'hold-or-sell' : 'buy-or-ignore'}-prompt.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  protected size(result: ChatPrompt): string {
    return `${result.chars.toLocaleString('en-IN')} characters · about ${result.approx_tokens.toLocaleString('en-IN')} tokens`;
  }
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'stock'
  );
}
