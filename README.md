This an inial readme File

## Database requirements

**MySQL 8.0.16 or later. MariaDB is not supported.**

The floor is 8.0.16 because that is where MySQL began *enforcing* `CHECK`
constraints. Below it the constraints in `db/schema.sql` parse and are then
silently ignored, so the schema applies with none of its integrity guarantees.
MariaDB is excluded because it has no `utf8mb4_0900_*` collations, and the
email uniqueness guarantee depends on `utf8mb4_0900_as_ci`.

Both are enforced at runtime: `npm run db:migrate` and `npm run db:seed` refuse
to proceed on an unsupported server. The bundled `docker-compose.yml` provides
a correctly configured `mysql:8.4`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the schema change process, and note
in particular that `prisma migrate dev` must never be run in this repository.

The server must also run in **strict SQL mode** (`STRICT_TRANS_TABLES`, a MySQL
8 default). Without it an out-of-set `ENUM` value is stored as the empty string
with only a warning, and the affected donation then matches no status filter —
it vanishes from every report while still sitting in the table.
