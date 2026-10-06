-- The institution's own framework is called "Internal Quality Framework"; rename the one set up under the earlier default.
UPDATE framework SET name = 'Internal Quality Framework' WHERE internal AND name = 'Quality framework';
