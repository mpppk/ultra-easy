# **15. 主要ユースケースと整合性制御 — Part 4**

## **例: AssistantがCEOのauthorityを限定委譲されて申請する、Managerの期間付き代理人が承認する。actor/authority/delegation chainを分離し、実効権限のattenuationはActionAuthorizer、代理承認者のrelation解決はOpenFGA Adapterで行う。Delegationの作成・失効はActionRequestとは別の管理resource/APIで扱う。**

## 

## **8\. Dynamic / Snapshot承認者**

## **例: 承認待ち中に直属上司やApproval Group membershipが変更される。現在のrelationへ追従する場合はdynamic、activation時点の候補を固定する場合はsnapshotを使用する。API contractは変えず、Decision受理時のcandidate semanticsのみが異なる。**

## 

## **9\. 変更・取消・再申請・再承認**

## **例: 承認後にamount/resource/permissionを変更する、Rejected後に修正して再申請する。承認Decisionはappend-onlyとし、approvalBindingFingerprintが変わる変更では既存承認を再利用せず、新ActionRequestとしてAuthorization・Policy評価をやり直す。単なる表示文言等を再承認対象外にしたい場合はAction Definitionのnormalization/fingerprint contractで明示する。**

## 

## **10\. Expiry / Timeout / Escalation / Reminder**

## **Approval expiryはv1のStep semanticsとして扱い、期限到達時はexpiredで終了する。Reminder、時間経過による承認者追加・reassign、SLA escalationはv1.1拡張とする。timeoutによるauto-approveはv1標準機能にしない。**

## 

## **11\. Break Glass / Post Approval / Exception / Override**

## **通常の\`Authorize→Approve→Re-Authorize→Execute\`とは実行順序が異なるため、一般化したbreak-glass/post-approvalはv1.x拡張とする。Exception/Policy Override自体は高権限ActionRequestとして扱い、reasonと監査証跡を必須にできる。通常の承認を管理者フラグで暗黙に迂回しない。**

## 

## **12\. Partial / Line-item / Bulk**

## **複数resource/itemを個別にapprove/rejectできる要求は、v1では各実操作を独立ActionRequestへ分解する。例: Repo A/B/Cへのaccess grantは3つのActionRequestとする。将来、複数ActionRequestを束ねる\`BatchRequest\`/plan approvalをaggregation resourceとして追加できるが、Partial Approval semanticsをFlow ASTへ直接混ぜない。**

## 

## **13\. Governance / 管理操作**

## **Action Definition、Approval Policy、Policy Bindingのpublish/update、Delegation、force-cancel等の基盤管理操作もActionRequestとして認可・必要なら承認できる。Simulator/Explain/Auditは実操作を行わない管理機能として分離する。bootstrap時の初期Policy/BindingのみIaCまたは署名済みmigrationを許可する。**

## 

## **15.9 チケット管理システム統合シーケンス**

## **チケットシステムは「承認が必要か」を事前に判断して別APIを選択してはならない。変更系の業務操作は原則\`POST /action-requests\`へ統一し、認証済みactor、ticketの現在状態・project/orgUnit/classification等のtrusted resource contextをApplication Adapterが補完する。actorやauthorityを任意request bodyだけから信用しない。**

## 

## **承認不要:**

## **\`POST /action-requests\` → Action Definition validation → ActionAuthorizer ALLOW → Approval Plan=\`none\` → Re-Authorization → ActionExecutor → \`executed\`。**

## 

## **承認あり:**

## **\`POST /action-requests\` → ActionAuthorizer ALLOW → Policy/Binding評価 → Materialized Approval Plan → Generic ActionWorkflow → \`pending\_approval\`。承認者は\`GET /me/approval-tasks\`でTaskを取得し、\`POST /approval-tasks/:taskId/decisions\`でDecisionを送る。Flow完了後にRe-Authorizationを行いActionExecutorがticket操作を実行する。**

## 

## **多段・parallel/quorum:**

## **利用APIは単一承認と同じとし、次Step activation、候補者解決、quorum計算をクライアントへ露出しない。**

## 

## **重要: Ticket Applicationが\`checkPermission()\`の成功後に別トランザクションでticketを直接更新する方式を標準にしない。認可から実行までをActionRequest/ActionExecutor経路へ含め、承認待ち中の権限失効もRe-Authorizationで検出する。これによりTOCTOUを縮小する。**

## 

## **15.10 Approval Flowの責務外となるチケット認可**
