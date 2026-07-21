---
"@dwk/micropub": minor
---

Implement the first tranche of IndieWeb Micropub extensions, toggled by maturity
group. A new `extensions` config (`{ official?, stable?, proposed? }`; defaults
`official`+`stable` on, `proposed` off) enables extensions a group at a time.

All new extensions are **stable**:

- **Post Status** (`post-status`) and **Visibility** (`visibility`) — their
  values are validated on create and on the merged result of an update
  (unrecognised values are rejected `400 invalid_request`; an absent property is
  the documented default). The endpoint stores and advertises these; read-time
  enforcement (hiding drafts, gating private posts) remains the serving layer's
  responsibility.
- **Supported Vocabulary** — an optional `postTypes` config is advertised as
  `post-types` in `q=config`.
- **Category/Tag List** (`q=category`) — returns the distinct string `category`
  tags across live posts (soft-deleted excluded), alphabetised, for autocomplete;
  narrowable via the stable **Limit** (`limit`) and **Filter** (`filter`)
  parameters.

Exports `validateVocabulary`, `POST_STATUS_VALUES`, `VISIBILITY_VALUES`, and the
`ExtensionMaturity`, `ExtensionGroupsConfig`, and `PostTypeConfig` types.
Post-list (`q=source` with no `url`) is tracked separately (#351/#353).
