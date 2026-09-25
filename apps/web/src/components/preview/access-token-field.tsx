import { useState } from "react";

import { readPreviewToken, storePreviewToken } from "#/preview/client.ts";

/** preview harness APIの共有トークン入力欄（sessionStorageに保持する）。 */
export function PreviewAccessTokenField() {
  const [token, setToken] = useState(readPreviewToken);
  return (
    <label style={{ display: "flex", gap: 8, alignItems: "center", marginBlock: 12 }}>
      Preview access token
      <input
        type="password"
        autoComplete="off"
        value={token}
        onChange={(event) => {
          setToken(event.target.value);
          storePreviewToken(event.target.value);
        }}
      />
    </label>
  );
}
