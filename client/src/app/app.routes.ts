import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'leaderboard' },
  {
    path: 'leaderboard',
    title: 'Leaderboard · Kosha',
    loadComponent: () => import('./features/leaderboard/leaderboard').then((m) => m.Leaderboard),
  },
  {
    path: 'signals',
    title: 'Sell signals · Kosha',
    loadComponent: () => import('./features/sell-signals/sell-signals').then((m) => m.SellSignals),
  },
  {
    path: 'funds',
    title: 'Funds · Kosha',
    loadComponent: () => import('./features/funds/funds').then((m) => m.Funds),
  },
  {
    path: 'jobs',
    title: 'Scrape jobs · Kosha',
    loadComponent: () => import('./features/jobs/jobs').then((m) => m.Jobs),
  },
  {
    path: '**',
    title: 'Not found · Kosha',
    loadComponent: () => import('./features/not-found/not-found').then((m) => m.NotFound),
  },
];
