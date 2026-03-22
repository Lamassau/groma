import { Construct } from "constructs";
import { FullStackChart, FullStackChartProps } from "./lib/charts/full-stack";

/**
 * Futbalio app chart.
 *
 * Barebones wrapper that inherits reusable chart behavior from lib/charts.
 * Keep app-specific customization here only when needed.
 */
export class FutbalioChart extends FullStackChart {
  constructor(scope: Construct, id: string, props: FullStackChartProps) {
    super(scope, id, props);
  }
}
