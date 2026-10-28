import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { errorInterceptor } from '../../../core/error.interceptor';
import { ChatPrompt } from '../../../core/models/stock-analysis';
import { ChatPromptPanel } from './chat-prompt-panel';

function prompt(partial: Partial<ChatPrompt> = {}): ChatPrompt {
  return {
    stock: { id: 7, name: 'City Union Bank Ltd', isin: 'INE491A01021', symbol: 'CUB' },
    held: false,
    prompt: '# Stock decision session: City Union Bank Ltd\n\n## Data\n...',
    chars: 21775,
    approx_tokens: 5444,
    sections: ['profile', 'financials'],
    stale_sections: [],
    errors: [],
    ...partial,
  };
}

describe('ChatPromptPanel', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatPromptPanel],
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
  });

  function create(held = false) {
    const fixture = TestBed.createComponent(ChatPromptPanel);
    fixture.componentRef.setInput('stockId', 7);
    fixture.componentRef.setInput('held', held);
    fixture.detectChanges();
    return fixture;
  }

  const el = (fixture: { nativeElement: unknown }) => fixture.nativeElement as HTMLElement;

  it('does nothing until asked, then fetches the prompt for the held flag and shows it', async () => {
    const fixture = create(true);
    http.expectNone(() => true);
    (el(fixture).querySelector('.cp__trigger') as HTMLButtonElement).click();
    fixture.detectChanges();

    const request = http.expectOne((r) => r.url === '/api/stocks/7/chat-prompt');
    expect(request.request.params.get('held')).toBe('true');
    request.flush(prompt({ held: true }));
    await fixture.whenStable();
    fixture.detectChanges();

    const area = el(fixture).querySelector('textarea') as HTMLTextAreaElement;
    expect(area.value).toContain('# Stock decision session');
    expect(el(fixture).textContent).toContain(
      '21,775 characters · about 5,444 tokens · hold or sell',
    );
  });

  it('copies to the clipboard and reports success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const fixture = create();
    (el(fixture).querySelector('.cp__trigger') as HTMLButtonElement).click();
    http.expectOne((r) => r.url === '/api/stocks/7/chat-prompt').flush(prompt());
    await fixture.whenStable();
    fixture.detectChanges();

    const copy = Array.from(el(fixture).querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Copy',
    ) as HTMLButtonElement;
    copy.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(writeText).toHaveBeenCalledWith(prompt().prompt);
    expect(el(fixture).textContent).toContain('Copied ✓');
  });

  it('lists data that could not be fetched and shows backend errors', async () => {
    const fixture = create();
    (el(fixture).querySelector('.cp__trigger') as HTMLButtonElement).click();
    http
      .expectOne((r) => r.url === '/api/stocks/7/chat-prompt')
      .flush(
        prompt({ errors: [{ section: 'price_history', code: 'rate_limited', message: 'quota' }] }),
      );
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el(fixture).textContent).toContain('missing from the prompt');
    expect(el(fixture).textContent).toContain('price_history.');

    fixture.componentRef.setInput('held', true);
    fixture.detectChanges();
    expect(el(fixture).querySelector('textarea')).toBeNull();

    (el(fixture).querySelector('.cp__trigger') as HTMLButtonElement).click();
    http
      .expectOne((r) => r.url === '/api/stocks/7/chat-prompt')
      .flush(
        { error: 'LLM analysis is not configured' },
        { status: 503, statusText: 'Service Unavailable' },
      );
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el(fixture).textContent).toContain('LLM analysis is not configured');
  });
});
