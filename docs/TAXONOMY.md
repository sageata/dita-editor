# Taxonomy configuration

`ditaeditor.visual.taxonomyFile` points to optional, inert JSON data inside the active topic's local workspace folder. It defines property controls; it cannot execute code or change the DITA schema.

## Version 1 schema

```json
{
  "version": 1,
  "fields": [
    { "attribute": "audience", "label": "Audience", "input": "text", "group": "Metadata" },
    {
      "attribute": "status",
      "label": "Status",
      "input": "single-select",
      "options": [
        { "value": "draft", "label": "Draft" },
        { "value": "review", "label": "Review" }
      ]
    }
  ]
}
```

Each field requires a unique `attribute`, `label`, and `input`. Inputs are `text`, `number`, `date`, `single-select`, or `multi-select`; `group` is optional. Select inputs require a non-empty `options` array with unique non-empty values and labels. Non-select inputs must not have options. Multi-select values cannot contain whitespace. Attribute names use the namespace-free ASCII NCName subset (`[A-Za-z_][A-Za-z0-9._-]*`) and cannot begin with any case variation of `xml`.

The exact limits are 1,048,576 UTF-8 bytes per file, 128 fields, 1,000 options per field, 10,000 options total, and 512 UTF-16 code units per string. Strings must contain only valid XML code points, paired surrogates, and no Unicode noncharacters.

## Loading and invalidation

The file is strictly decoded as UTF-8 and reloaded when its file, open document, setting, trust state, or workspace-folder resolution changes. A newer change supersedes an older in-flight read. Deleting, disabling, or changing the file immediately clears the previous taxonomy so stale fields are never left active.

An empty setting disables taxonomy. Invalid JSON, an inaccessible or escaped path, a limit violation, or any schema error disables taxonomy and logs the reason to the DITA Editor output channel; normal DITA properties remain available. Restricted Mode disables the file setting and clears taxonomy. Symlinks are accepted only when the canonical target remains inside the selected local workspace folder. The example above is synthetic data for documentation only and is never injected into the runtime UI.
