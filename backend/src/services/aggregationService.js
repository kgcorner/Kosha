export class AggregationService {
  constructor({ repository, ollamaService, aiConfiguration }) {
    this.repository = repository;
    this.ollamaService = ollamaService;
    this.aiConfiguration = aiConfiguration;
  }

  async run() {
    this.repository.recompute();
    if (!this.aiConfiguration.enabled) return;

    const stocks = this.repository.unanalyzed(this.aiConfiguration.top_stock_limit);
    for (const stock of stocks) {
      const result = await this.ollamaService.analyze(stock);
      this.repository.saveAnalysis.run(
        result.thesis,
        JSON.stringify(result.pros),
        JSON.stringify(result.cons),
        stock.stock_id
      );
    }
  }
}
