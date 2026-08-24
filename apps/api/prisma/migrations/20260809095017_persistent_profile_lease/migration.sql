-- CreateTable
CREATE TABLE "browser_runtime_profile_leases" (
    "id" UUID NOT NULL,
    "runtime_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "profile_key" TEXT NOT NULL,
    "lease_token" UUID NOT NULL,
    "fencing_token" BIGINT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "browser_runtime_profile_leases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "browser_runtime_profile_leases_session_id_key" ON "browser_runtime_profile_leases"("session_id");

-- CreateIndex
CREATE INDEX "browser_runtime_profile_leases_expires_at_idx" ON "browser_runtime_profile_leases"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "browser_runtime_profile_leases_runtime_id_profile_key_key" ON "browser_runtime_profile_leases"("runtime_id", "profile_key");

-- AddForeignKey
ALTER TABLE "browser_runtime_profile_leases" ADD CONSTRAINT "browser_runtime_profile_leases_runtime_id_fkey" FOREIGN KEY ("runtime_id") REFERENCES "browser_runtimes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_runtime_profile_leases" ADD CONSTRAINT "browser_runtime_profile_leases_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "browser_runtime_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
