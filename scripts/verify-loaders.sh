#!/usr/bin/env bash
# Full four-loader acceptance test for the pure-JS PDF toolchain.
#
# Loads every shipped document into a throwaway database and compares the rows
# against fixtures/baseline.json. Any drift means the toolchain swap changed what
# the loaders extract, which must be zero.
#
# `npm run db:build` is the same chain, writing prisma/customs.db and running this
# same comparison as its gate. This stays separate because it takes a scratch path
# and never touches the database you are running the app against.
#
#   bash scripts/verify-loaders.sh /tmp/parity.db
set -euo pipefail
DB="${1:?usage: verify-loaders.sh <scratch-db-path>}"
export DB_PROVIDER=sqlite
export DATABASE_URL="file:$DB"

rm -f "$DB"
npx prisma db push --schema prisma/schema.prisma --skip-generate --accept-data-loss >/dev/null
# Adds the FTS index and anything else the schema alone does not create.
npx tsx scripts/migrate.ts
echo "scratch database created at $DB"

npx tsx scripts/load-cet.ts            public/docs/cet.pdf
npx tsx scripts/load-misc-levies.ts    public/docs/misc-fees-and-levies.pdf
npx tsx scripts/load-finance-act.ts    public/docs/finance-act-2026.pdf
npx tsx scripts/load-routine-order.ts  public/docs/routine-order-2026.pdf
npx tsx scripts/seed-aliases.ts

echo "--- comparing against fixtures/baseline.json ---"
npx tsx scripts/compare-load.ts "$DB"
