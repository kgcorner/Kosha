import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('renders the brand and the four primary navigation links', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;

    expect(compiled.querySelector('.brand__name')?.textContent).toContain('Kosha');

    const hrefs = [...compiled.querySelectorAll('nav.nav a')].map((link) =>
      link.getAttribute('href'),
    );
    expect(hrefs).toEqual(['/leaderboard', '/signals', '/funds', '/jobs']);
  });

  it('shows the idle scrape indicator before any job is tracked', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const indicator = fixture.nativeElement.querySelector('.scrape-indicator');

    expect(indicator?.textContent).toContain('Idle');
  });
});
