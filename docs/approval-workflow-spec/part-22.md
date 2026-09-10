# **18\. マルチテナントとセキュリティ**

## **18.1 Tenant boundary**

すべてのApplication queryはorganization\_idでscopeする。IDだけで他tenantのWorkflow/Policyへ到達できないよう、Repository API自体をtenant-awareに設計する。

## **18.2 FGA tenant separation**

Auth0 FGA Storeの分割方式（shared store / tenantごとのstore）は運用要件により決定するため本仕様では未確定とする。ただしshared storeの場合、object IDまたはmodel relationにtenant boundaryを明示し、tenant scopeのないListObjects/ListUsersをApplication APIから直接公開しない。

## **18.3 Credential separation**

FGA Client Credentialsはserver-sideのみで保持し、用途ごとに最小権限のAuthorized Clientを利用する。ブラウザへFGA credentialを配布しない。

## **18.4 Authorization layering**

Authentication  
  AND tenant boundary  
  AND authority/delegation attenuation  
  AND resource authorization (FGA等)  
  THEN Approval Policy / Flow  
  AND Flow Interpreter execution constraints  
  AND approver authorization  
  AND business constraints (e.g. self-approval)

## **18.5 D1 tenant topologyとスケーリング**

v1はshared D1 database \+ organization\_id scopeを標準とする。D1は多数の小さいdatabaseへ水平分割する用途を想定しているため、単一databaseの10 GB上限やwrite throughputがボトルネックになった場合はtenant単位またはtenant group単位のdatabase分割を行う。Repositoryは将来のshardingに備え、tenantからD1 binding/databaseを解決する境界をApplication層に設ける。

## **18.6 Policy / Binding変更管理**

# **Action Definitionのpublish、Approval Policyのpublish、ApprovalPolicyBindingのcreate/update/disableは通常の管理CRUDとして無審査で実行せず、それぞれ\`action\_definition.publish\`、\`approval\_policy.publish\`、\`approval\_policy\_binding.update\`等のActionRequestとして本基盤自身のAuthorization/Approvalを通す。bootstrap時の初期Policy/BindingのみIaCまたは署名済みmigrationから投入し、以後はmeta-approvalを適用する。**

# 

## **18.7 管理者による復旧操作**

# **v1は\`admin.force\_cancel\`を高権限Actionとして提供する。Workflow不具合、組織データ不整合、長期停止等から復旧するための運用escape hatchであり、実行者・理由・対象ActionRequest・時刻を必ずappend-only監査し、\`post\_review\_required=true\`を残す。\`force approve\`はv1では提供しない。**

# 

## **18.8 通知semantics**

# **Approval Step activation、Decision適用、reject/cancel/expire、Action完了を通知発火点としてdomain eventから\`notification.requested\` Outbox eventを生成する。Step activation時の通知対象はapproval\_task\_candidatesまたはdirect user targetから決定し、同一event keyに対する通知生成はidempotentとする。チャネル、テンプレート、多言語、リマインド、escalationはAdapter/設定の責務とし、v1.1以降で拡張可能とする。**

# 

## **18.9 データライフサイクル・添付**

# **領収書・見積書・契約書等の添付はAction inputへ本文を埋め込まず、\`{ storageKey, sha256, size, contentType }\`等のimmutable attachment referenceとして持つ。添付content hashはactionFingerprintへ含め、承認後の差し替えを別Actionとして検出する。実体はR2等のobject storageへ保存し、tenant scopeを検証した短期署名URL等でアクセスする。Action input、Decision comment、actor情報等のPIIにはtenantごとの保持期限を設定し、法令・監査要件と削除要求が衝突する場合のarchive/crypto-shredding方式を運用設計で定める。**

# 

## **18.10 Observability**

# **actionRequestIdをtrace root/correlation idとしてHTTP/MCP→Workflow→D1→FGA→ActionExecutor→通知へ伝播する。最低限、Step滞留時間、承認リードタイム、reject/expire率、FGA Check/ListUsers latency/error、Workflow retry/failure、Executor failureを計測する。ログへAction inputやDecision comment等の機微情報を無制限に出力しない。**

#
