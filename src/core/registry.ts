import { BaseProvider, type ModelInfo } from './provider.js';
import { InvalidModelError } from './errors.js';

export interface ProviderStatus {
  id: string;
  name: string;
  website: string;
  authenticated: boolean;
  modelCount: number;
}

export class ProviderRegistry {
  private providers = new Map<string, BaseProvider>();

  /** `fallbackModel` serves ids no provider has, e.g. Claude Code subagents asking for claude-sonnet-5-5. */
  constructor(private readonly fallbackModel: string | null = null) {}

  register(provider: BaseProvider): void {
    this.providers.set(provider.info.id, provider);
  }

  async resolve(modelId: string): Promise<{ provider: BaseProvider; model: string }> {
    const slashIndex = modelId.indexOf('/');

    // Explicit provider/model format
    if (slashIndex > 0 && slashIndex < modelId.length - 1) {
      const providerId = modelId.slice(0, slashIndex);
      const model = modelId.slice(slashIndex + 1);

      const provider = this.providers.get(providerId);
      if (provider) {
        return { provider, model };
      }
      // provider not found — fall through to fuzzy match
    }

    // Fuzzy match: search all providers for a model with this ID
    for (const [, provider] of this.providers) {
      const models = await provider.models();
      if (models.some((m) => m.id === modelId)) {
        return { provider, model: modelId };
      }
    }

    if (this.fallbackModel && modelId !== this.fallbackModel) {
      console.warn(`[registry] ${new Date().toISOString()} unknown model "${modelId}", using fallback ${this.fallbackModel}`);
      return this.resolve(this.fallbackModel);
    }
    throw new InvalidModelError(modelId);
  }

  async allModels(): Promise<(ModelInfo & { id: string })[]> {
    const result: (ModelInfo & { id: string })[] = [];

    for (const [providerId, provider] of this.providers) {
      if (!(await provider.isAuthenticated())) continue;
      const models = await provider.models();
      for (const m of models) {
        result.push({ ...m, id: `${providerId}/${m.id}` });
      }
    }

    return result;
  }

  async providerStatus(): Promise<ProviderStatus[]> {
    const result: ProviderStatus[] = [];

    for (const [, provider] of this.providers) {
      const authenticated = await provider.isAuthenticated();
      let modelCount = 0;
      if (authenticated) {
        modelCount = (await provider.models()).length;
      }
      result.push({
        id: provider.info.id,
        name: provider.info.name,
        website: provider.info.website,
        authenticated,
        modelCount,
      });
    }

    return result;
  }

  getProvider(id: string): BaseProvider | undefined {
    return this.providers.get(id);
  }
}
