import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-not-found',
  imports: [RouterLink],
  template: `
    <section class="state">
      <p class="state__title">Page not found</p>
      <p class="state__message">The page you were looking for doesn’t exist or has moved.</p>
      <a class="btn btn--primary" routerLink="/leaderboard">Back to leaderboard</a>
    </section>
  `,
})
export class NotFound {}
