import { describe, expect, it } from "vitest";

import { toNonSslConnectionString } from "./db.js";

describe("toNonSslConnectionString", () => {
  it("removes SSL-related query params from standard Postgres URLs", () => {
    const input =
      "postgresql://user:pass@localhost:5432/brain?sslmode=require&ssl=true&sslcert=a&sslkey=b&sslrootcert=c&application_name=myco";
    const output = toNonSslConnectionString(input);
    const parsed = new URL(output);

    expect(parsed.searchParams.get("sslmode")).toBeNull();
    expect(parsed.searchParams.get("ssl")).toBeNull();
    expect(parsed.searchParams.get("sslcert")).toBeNull();
    expect(parsed.searchParams.get("sslkey")).toBeNull();
    expect(parsed.searchParams.get("sslrootcert")).toBeNull();
    expect(parsed.searchParams.get("application_name")).toBe("myco");
  });
});
