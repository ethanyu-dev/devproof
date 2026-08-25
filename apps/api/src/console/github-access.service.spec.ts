import { describe, expect, it, vi } from "vitest";

import { GithubAccessService } from "./github-access.service.js";

const current = {
  team: { id: "4a9f2473-0b1f-4de8-87d7-2ac49b425d75" },
  user: { id: "89bc00dd-5c69-4794-8dad-e55db5cb0ceb" },
} as never;

const publicRow = {
  createdAt: new Date("2026-08-25T00:00:00.000Z"),
  enabled: true,
  id: "credential-1",
  name: "Organization A primary",
  organizations: ["organization-a"],
  priority: 100,
  repositories: [],
  tokenHint: "••••cdef",
  updatedAt: new Date("2026-08-25T00:00:00.000Z"),
};

describe("GithubAccessService", () => {
  it("creates encrypted list entries and never returns credential material", async () => {
    const prisma = {
      githubAccessCredential: {
        create: vi.fn().mockResolvedValue(publicRow),
      },
    };
    const cipher = {
      decrypt: vi.fn(),
      encrypt: vi.fn().mockReturnValue("v1.secret-envelope"),
      hint: vi.fn().mockReturnValue("••••cdef"),
    };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const service = new GithubAccessService(
      prisma as never,
      cipher as never,
      audit as never,
    );

    const result = await service.create(current, {
      enabled: true,
      name: "Organization A primary",
      organizations: ["organization-a"],
      personalAccessToken: "github_pat_abcdefghijklmnop_cdef",
      priority: 100,
      repositories: [],
    });

    expect(cipher.encrypt).toHaveBeenCalledWith(
      "github_pat_abcdefghijklmnop_cdef",
    );
    expect(prisma.githubAccessCredential.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizations: ["organization-a"],
          teamId: current.team.id,
          tokenEncrypted: "v1.secret-envelope",
          tokenHint: "••••cdef",
        }),
      }),
    );
    expect(result).toEqual(publicRow);
    expect(JSON.stringify(result)).not.toContain("secret-envelope");
    expect(JSON.stringify(result)).not.toContain("abcdefghijklmnop");
    expect(audit.record).toHaveBeenCalledWith(
      current,
      "github.credential.created",
      "github_access_credential",
      "credential-1",
      expect.objectContaining({ tokenHint: "••••cdef" }),
    );
  });

  it("routes exact repositories before organizations and defaults", async () => {
    const prisma = {
      githubAccessCredential: {
        findMany: vi.fn().mockResolvedValue([
          {
            createdAt: new Date("2026-08-25T00:00:00.000Z"),
            id: "default",
            name: "Default",
            organizations: [],
            priority: 1000,
            repositories: [],
            tokenEncrypted: "encrypted-default",
          },
          {
            createdAt: new Date("2026-08-25T00:01:00.000Z"),
            id: "org-secondary",
            name: "Organization A secondary",
            organizations: ["organization-a"],
            priority: 50,
            repositories: [],
            tokenEncrypted: "encrypted-org-secondary",
          },
          {
            createdAt: new Date("2026-08-25T00:02:00.000Z"),
            id: "org-primary",
            name: "Organization A primary",
            organizations: ["organization-a"],
            priority: 100,
            repositories: [],
            tokenEncrypted: "encrypted-org-primary",
          },
          {
            createdAt: new Date("2026-08-25T00:03:00.000Z"),
            id: "exact",
            name: "Core exact",
            organizations: [],
            priority: 1,
            repositories: ["organization-a/core-api"],
            tokenEncrypted: "encrypted-exact",
          },
          {
            createdAt: new Date("2026-08-25T00:04:00.000Z"),
            id: "other-org",
            name: "Organization B",
            organizations: ["organization-b"],
            priority: 500,
            repositories: [],
            tokenEncrypted: "encrypted-other",
          },
        ]),
      },
    };
    const cipher = {
      decrypt: vi.fn((value: string) => value.replace("encrypted-", "token-")),
    };
    const service = new GithubAccessService(
      prisma as never,
      cipher as never,
      {} as never,
    );

    const result = await service.candidatesForRepository(
      current.team.id,
      "Organization-A",
      "Core-API",
    );

    expect(result.map((candidate) => candidate.id)).toEqual([
      "exact",
      "org-primary",
      "org-secondary",
      "default",
    ]);
    expect(result[0]?.token).toBe("token-exact");
    expect(prisma.githubAccessCredential.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { enabled: true, teamId: current.team.id },
      }),
    );
  });

  it("checks repository routing without decrypting PATs", async () => {
    const prisma = {
      githubAccessCredential: {
        findMany: vi.fn().mockResolvedValue([
          {
            organizations: ["organization-a"],
            repositories: [],
          },
        ]),
      },
    };
    const cipher = { decrypt: vi.fn() };
    const service = new GithubAccessService(
      prisma as never,
      cipher as never,
      {} as never,
    );

    await expect(
      service.hasCandidateForRepository(
        current.team.id,
        "Organization-A",
        "Core-API",
      ),
    ).resolves.toBe(true);
    expect(cipher.decrypt).not.toHaveBeenCalled();
  });

  it("keeps the encrypted PAT unchanged when only routing is updated", async () => {
    const prisma = {
      githubAccessCredential: {
        findFirst: vi.fn().mockResolvedValue({ id: publicRow.id }),
        update: vi.fn().mockResolvedValue({
          ...publicRow,
          organizations: ["organization-a", "organization-b"],
        }),
      },
    };
    const cipher = { encrypt: vi.fn(), hint: vi.fn() };
    const service = new GithubAccessService(
      prisma as never,
      cipher as never,
      { record: vi.fn() } as never,
    );

    await service.update(current, publicRow.id, {
      enabled: true,
      name: publicRow.name,
      organizations: ["organization-a", "organization-b"],
      priority: 100,
      repositories: [],
    });

    expect(cipher.encrypt).not.toHaveBeenCalled();
    expect(prisma.githubAccessCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({
          tokenEncrypted: expect.anything(),
        }),
      }),
    );
  });
});
