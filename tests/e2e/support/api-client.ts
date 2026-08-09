import { getEnvVar } from "./env";

export class ApiClient {
  private readonly baseUrl: string;
  private readonly adminKey: string;

  constructor(baseUrl = getEnvVar("API_BASE_URL", "http://localhost:3001")) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.adminKey = getEnvVar("ADMIN_API_KEY");
  }

  async health(): Promise<Response> {
    return fetch(`${this.baseUrl}/api/healthz`, { cache: "no-store" });
  }

  async get<T = unknown>(
    path: string,
    opts: { admin?: boolean; headers?: Record<string, string> } = {},
  ): Promise<T> {
    return this.request<T>(path, {
      admin: opts.admin,
      headers: opts.headers,
    });
  }

  async post<T = unknown>(
    path: string,
    data: unknown,
    opts: { admin?: boolean; headers?: Record<string, string> } = {},
  ): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: JSON.stringify(data),
      headers: {
        "content-type": "application/json",
        ...opts.headers,
      },
      admin: opts.admin,
    });
  }

  private async request<T>(
    path: string,
    init: RequestInit & { admin?: boolean } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string>),
    };

    if (init.body && !headers["content-type"]) {
      headers["content-type"] = "application/json";
    }

    if (init.admin !== false) {
      headers["x-api-key"] = this.adminKey;
    }

    const { admin: _admin, ...fetchInit } = init;
    const response = await fetch(url, {
      ...fetchInit,
      headers,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `API request failed ${response.status} ${response.statusText} (${url}) ${text}`,
      );
    }

    const text = await response.text();
    return text ? (JSON.parse(text) as T) : ({} as T);
  }
}
