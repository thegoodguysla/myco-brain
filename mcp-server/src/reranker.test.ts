import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PassThroughReranker,
  CohereReranker,
  createReranker,
  type RerankCandidate,
} from "./reranker.js";

const CANDIDATES: RerankCandidate[] = [
  { id: "c1", text: "Brain uses pgvector for embeddings", score: 0.8 },
  { id: "c2", text: "Slack connector syncs messages daily", score: 0.5 },
  { id: "c3", text: "Cohere reranker improves precision", score: 0.9 },
  { id: "c4", text: "BM25 handles entity-dense queries", score: 0.6 },
];

describe("PassThroughReranker", () => {
  it("sorts by score descending", async () => {
    const r = new PassThroughReranker();
    const result = await r.rerank("brain search", CANDIDATES, 4);
    expect(result.map((c) => c.id)).toEqual(["c3", "c1", "c4", "c2"]);
  });

  it("respects limit", async () => {
    const r = new PassThroughReranker();
    const result = await r.rerank("brain", CANDIDATES, 2);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("c3"); // highest score
  });

  it("does not mutate the original array", async () => {
    const r = new PassThroughReranker();
    const original = [...CANDIDATES];
    await r.rerank("q", CANDIDATES, 4);
    expect(CANDIDATES).toEqual(original);
  });

  it("handles empty candidates", async () => {
    const r = new PassThroughReranker();
    const result = await r.rerank("query", [], 10);
    expect(result).toEqual([]);
  });

  it("handles limit larger than candidates", async () => {
    const r = new PassThroughReranker();
    const result = await r.rerank("q", CANDIDATES, 100);
    expect(result).toHaveLength(CANDIDATES.length);
  });
});

describe("createReranker", () => {
  it("returns PassThroughReranker for 'none'", () => {
    const r = createReranker("none");
    expect(r).toBeInstanceOf(PassThroughReranker);
  });

  it("throws for 'cohere' without COHERE_API_KEY", () => {
    delete process.env.COHERE_API_KEY;
    expect(() => createReranker("cohere")).toThrow("COHERE_API_KEY");
  });

  it("returns CohereReranker when COHERE_API_KEY is set", () => {
    process.env.COHERE_API_KEY = "test-key-123";
    const r = createReranker("cohere");
    expect(r).toBeInstanceOf(CohereReranker);
    delete process.env.COHERE_API_KEY;
  });
});

describe("CohereReranker", () => {
  afterEach(() => {
    delete process.env.COHERE_API_KEY;
    vi.restoreAllMocks();
  });

  it("calls Cohere API and maps results back to candidates", async () => {
    process.env.COHERE_API_KEY = "test-key";

    const mockResponse = {
      results: [
        { index: 2, relevance_score: 0.95 },
        { index: 0, relevance_score: 0.72 },
        { index: 3, relevance_score: 0.61 },
      ],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      })
    );

    const r = new CohereReranker();
    const result = await r.rerank("brain reranker", CANDIDATES, 3);

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe("c3"); // index 2 → c3
    expect(result[0].score).toBeCloseTo(0.95);
    expect(result[1].id).toBe("c1"); // index 0 → c1
    expect(result[1].score).toBeCloseTo(0.72);
    expect(result[2].id).toBe("c4"); // index 3 → c4
  });

  it("sends correct request payload to Cohere", async () => {
    process.env.COHERE_API_KEY = "test-key";

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = new CohereReranker("rerank-v3.5");
    await r.rerank("my query", CANDIDATES.slice(0, 2), 2);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.cohere.com/v2/rerank");

    const body = JSON.parse(options.body);
    expect(body.query).toBe("my query");
    expect(body.model).toBe("rerank-v3.5");
    expect(body.documents).toHaveLength(2);
    expect(body.top_n).toBe(2);
    expect(body.return_documents).toBe(false);
    expect(options.headers["Authorization"]).toBe("Bearer test-key");
  });

  it("throws on non-ok Cohere response", async () => {
    process.env.COHERE_API_KEY = "test-key";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => "rate limited",
      })
    );

    const r = new CohereReranker();
    await expect(r.rerank("q", CANDIDATES, 4)).rejects.toThrow(
      "Cohere rerank failed (429)"
    );
  });

  it("returns empty array for empty candidates", async () => {
    process.env.COHERE_API_KEY = "test-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const r = new CohereReranker();
    const result = await r.rerank("q", [], 10);
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
