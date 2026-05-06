-- Add progress column to processes table for tracking epoch completion progress
ALTER TABLE processes ADD COLUMN IF NOT EXISTS progress float CHECK (progress >= 0 AND progress <= 1);
