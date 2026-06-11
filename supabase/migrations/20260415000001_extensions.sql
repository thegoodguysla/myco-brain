-- Migration 001: Extensions
-- Enable required Postgres extensions

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- trigram indexes for fuzzy name search
