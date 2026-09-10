# **15. 主要ユースケースと整合性制御 — Part 3**

## **15.7 必須境界ケースと追加ユースケース**

次のケースをv1の仕様・テストに含める。

・AIにauthorityがないがcallerがapproveしても実行不可。ApprovalはAuthorizationの権限昇格手段ではない。

・承認待ち中にdelegation/token scope/resource authorization/agent statusが失効した場合、実行直前Re-Authorizationで拒否する。

・AI作成者と現在callerが異なる場合、creator/caller/authority/delegatorを混同しない。

・自律Agentやservice principalでhuman callerが存在しない場合、callerを要求するPolicyはfail closedまたは明示fallbackを使う。

・Agent A→Agent Bの再委譲はDelegationHop chainとしてattenuationを検証し、下流Agentが強い権限を得ない。

・上長候補が0人の場合は既定deny。複数候補の場合はcandidateCompletionのany/all/quorumを適用する。

・承認待ち中の組織変更はdynamic/snapshot設定に従う。

・承認後にaction type/resource/input等の実操作内容が変化すればactionFingerprint、actor/authority/delegation/origin/settings等が変化すればevaluationSnapshotChecksum、適用Binding/Policy Version/Flow semanticsが変化すればapprovalPlanChecksumが変わる。approvalBindingFingerprintが一致しない既存承認は再利用せず、新ActionRequestとして再Authorization・PolicyBinding解決・Policy評価する。

・同一人物が複数Stepを満たしてよいかをFlow-level Separation of Duties制約で制御する。v1ではdistinctApprovers=trueを推奨し、複雑なSoDルールはv1.1で拡張する。

・大量の同一ActionRequestはidempotency/rate limitでapproval spamを抑制する。

・将来、単一ActionへのApprovalDecisionとは別に、一定scope・期間・agent runに対する一時許可をApprovalGrantとして扱う。allow once/session、batch/plan approval、approval expiry、break-glass + 事後reviewはv1.x以降の拡張候補とする。

## **15.8 チケット管理システム向け集約ユースケース**

## **チケット管理システムに現れる個別の認可・承認パターンは、Approval基盤の観点では以下の13種類へ集約して扱う。CRUD、所有者、部署、Role、Team、Project、Queue、機密度、状態、field visibility等の差をそのまま別Workflow機能として実装せず、Action Definition、ActionAuthorizer、ApprovalPolicyBinding、ApproverExpression、Flow constraintsの組み合わせとして表現する。**

## 

## **1\. 認可のみ・承認なし**

## **例: 担当者が担当チケットを更新する、閲覧権限保持者がコメントする、Managerが配下チケットを閲覧する。ActionAuthorizerがresource/state/contextを含めてALLOWし、Approval Planは\`{ type: "none" }\`とする。Workflow instanceは作成せずRe-Authorization後にActionExecutorを実行する。利用側は\`POST /action-requests\`だけを呼び、承認の要否を事前判定しない。**

## 

## **2\. 単一承認**

## **例: Critical priorityへの変更はIncident Manager承認、Repository accessはResource Owner承認、特定Ticket作成はManager承認。Flowは1個のApproval Stepとし、承認者は\`managerOf(authorityPrincipal())\`、resource relation、organization role/group等で表す。\`POST /action-requests\`がpending\_approvalになった後、承認者はinboxからTaskを取得してDecisionを送る。**

## 

## **3\. 順次多段承認**

## **例: Purchase RequestをManager→Finance→Directorの順に承認する。Flowは\`serial(...)\`で表す。クライアントは次Stepや次承認者を指定せず、各Step完了後のactivationはInterpreterが決定する。**

## 

## **4\. 条件付き承認**

## **例: 100万円以上ならDirectorを追加、個人情報を含むならPrivacyを追加、production/security riskならSecurityを追加する。独立したApprovalPolicyBindingを条件ごとに適用し、各Policyのfirst-match結果をApprovalPlanCompilerが決定的に合成する。利用側APIは金額・risk別に分けず、常に同じActionRequestを送信する。**

## 

## **5\. 並列・OR・AND・Quorum・Composite**

## **例: Security OR Compliance、Security AND Finance、委員5名中3名。Flowは\`parallel(strategy=any|all|quorum)\`または1 Step内の\`candidateCompletion\`で表現する。quorum計算や到達不能判定はInterpreterの責務であり、クライアントは各Decisionを送るだけとする。**

## 

## **6\. 自己承認禁止・Separation of Duties**

## **例: Requester自身は承認不可、MakerとCheckerを分離、Requester/Approver/Executorを別主体にする。\`selfApproval\`とFlow-level constraintsで表現し、違反Decisionはサーバー側で拒否する。クライアントのUI非表示だけを安全境界にしない。**

## 

## **7\. 代理・委任・代理申請**
