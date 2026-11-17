# USMS Visual Design System

## Brand direction

**Midnight Retail Command Centre** — a premium, high-contrast interface for shop owners and staff. The Business App should feel focused, modern and operational rather than like a generic white admin template.

## Core palette

| Token | Hex | Use |
|---|---|---|
| Midnight Black | `#0B0B0C` | Main app canvas and dark surfaces |
| Pure White | `#FFFFFF` | Primary text and high-contrast content |
| Lime Green | `#C6F432` | Primary actions, active navigation, key metrics and status highlights |

Supporting neutrals are allowed for hierarchy:
- Raised surfaces: `#141416`, `#1B1B1E`
- Borders: `#2B2B30`
- Muted text: `#A1A1AA`

## Application rules

1. Business App dashboard, navigation, cards, forms and POS panels use the Midnight/Lime theme.
2. Lime is an accent, not a background for large areas. Reserve it for primary actions, active states, important numbers and selected indicators.
3. Use white for primary text and muted grey for secondary labels.
4. Keep borders subtle and spacing generous; avoid excessive glow, gradients and neon effects.
5. Maintain strong contrast and clear focus states for keyboard and touch users.
6. Preserve responsive layouts and readable touch targets on mobile.
7. Invoice print output remains white and print-friendly; the dashboard theme must not affect printed invoices.
8. The customer Storefront remains merchant-brandable. Do not force the USMS admin palette onto every shop's public storefront; use the merchant's configured storefront colour and branding.

## Reference

The founder supplied a visual reference showing three swatches: Midnight Black `#0B0B0C`, Pure White `#FFFFFF`, and Lime Green `#C6F432`. This is the approved starting palette for the USMS Business App.


## Storefront application

The customer-facing Storefront uses the same premium Midnight foundation for its neutral surfaces, typography and structure, while retaining each merchant's configured `primaryColor` as the live accent through the `--store-color` CSS variable.

- Midnight Black `#0B0B0C` is the page canvas.
- Raised dark surfaces and subtle borders define product cards and checkout panels.
- White is used for product names and high-priority content; muted grey is used for descriptions and supporting metadata.
- Merchant-configured accent colour is used for primary calls to action, stock highlights, selected states and checkout/payment actions.
- Do not hard-code Lime Green as the public storefront's only accent; the default fallback may use the approved Lime Green, but each shop's own brand colour takes precedence.
- Product cards and controls must remain legible on mobile, with visible focus states and reduced-motion support.
- Business App remains USMS-branded in Midnight/Lime. Printed invoices remain white and print-friendly.


## Platform workspaces

The Super Admin control plane and owner Dashboard use the same Midnight/Lime foundation as the Business App:
- Midnight canvas and raised charcoal panels.
- White primary headings and lime-highlighted key metrics.
- Muted secondary text and restrained borders.
- Responsive single-column layouts on narrow screens.
- Visible keyboard focus and reduced-motion behavior.

These two apps currently contain foundation/preview content. Their visual theme does not imply that tenant registry, subscription billing, analytics or platform monitoring has been connected or made operational. Keep unavailable metrics represented as unavailable until backed by verified API data.
