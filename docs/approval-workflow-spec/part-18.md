# **15. 主要ユースケースと整合性制御 — Part 5**

## **field-level read/write、検索/list結果のauthorization filtering、notification visibility、parent/child permission inheritance、linked-ticket情報漏洩防止、tenant/external-user access、export権限、availableActions表示等は重要だが、個別のApproval Flow機能として実装しない。これらはTicket Application \+ ActionAuthorizer/OpenFGAのresource authorization責務とする。特にlist/searchは大量resourceを取得後に1件ずつCheckする設計を避け、authorization-aware filteringを別途設計する。Approval基盤は変更Actionの実行前承認を担当し、read projection/search engine自体の情報開示制御の正本にはならない。**

##
