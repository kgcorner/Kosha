import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { JobMonitorService } from './core/job-monitor';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly jobMonitor = inject(JobMonitorService);

  protected readonly job = this.jobMonitor.job;
  protected readonly isRunning = this.jobMonitor.isRunning;
  protected readonly isStale = this.jobMonitor.isStale;
  protected readonly stageLabel = this.jobMonitor.stageLabel;
  protected readonly statusLabel = this.jobMonitor.statusLabel;
  protected readonly progress = this.jobMonitor.progress;
}
