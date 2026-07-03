/**
 * IncrementalFallbackError
 *
 * Thrown when incremental analysis cannot resolve an import because the
 * target symbol is not in the parsed files (onlyFiles) and not found in
 * Neo4j either. When caught, the caller should fall back to full analysis.
 */
export class IncrementalFallbackError extends Error {
  constructor(
    message: string,
    public readonly missingSymbol: string,
  ) {
    super(message);
    this.name = 'IncrementalFallbackError';
  }
}
