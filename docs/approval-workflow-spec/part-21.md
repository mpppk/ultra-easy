# **17\. イベント・Outbox・監査**

## **17.1 Domain Events**

type ActionEvent \=  
  | { type: "action.received"; actionRequestId: string; actor: PrincipalRef; authority: PrincipalRef; caller?: PrincipalRef; delegationChain?: DelegationHop\[\]; actionFingerprint: string }  
  | { type: "action.authorized"; actionRequestId: string; evidence: AuthorizationEvidence }  
  | { type: "action.authorization\_denied"; actionRequestId: string; code: string; reason: string }  
  | { type: "action.authorization\_check\_failed"; actionRequestId: string; code: string }  
  | { type: "approval\_plan.materialized"; actionRequestId: string; evaluationSnapshotChecksum: string; approvalPlanChecksum: string; interpreterSemanticsVersion: number }  
  | { type: "workflow.started"; actionRequestId: string; workflowInstanceId: string }  
  | { type: "step.activated"; actionRequestId: string; materializedStepId: string; stepKey: string; purpose?: string; target?: ResolvedApproverTarget }  
  | { type: "step.approved"; actionRequestId: string; materializedStepId: string; stepKey: string; actorId: string }  
  | { type: "step.rejected"; actionRequestId: string; materializedStepId: string; stepKey: string; actorId: string }  
  | { type: "step.expired"; actionRequestId: string; materializedStepId: string; stepKey: string }  
  | { type: "action.reauthorized"; actionRequestId: string; evidence: AuthorizationEvidence }  
  | { type: "action.reauthorization\_denied"; actionRequestId: string; code: string; reason: string }  
  | { type: "action.reauthorization\_check\_failed"; actionRequestId: string; code: string }  
  | { type: "action.execution\_started"; actionRequestId: string; idempotencyKey: string }  
  | { type: "action.execution\_failed"; actionRequestId: string; code: string; retriable: boolean }  
  | { type: "action.completed"; actionRequestId: string; result: "executed" | "rejected" | "cancelled" | "expired" | "authorization\_revoked" | "authorization\_check\_failed" | "execution\_failed" };

## **17.2 Transactional Outbox**

Workflowのcanonical execution stateはCloudflare Workflowsが保持する。Interpreterが生成したdomain eventはstep.do()内でD1へappendし、必要なread projectionとOutboxを同一D1 batch()で更新する。Outbox Dispatcher Workerが未配送eventをCloudflare Queuesへ送り、consumer WorkerがSlack、Email、Webhook等へ配信する。組織変更→FGA Tuple同期にも同じ方式を利用する。

## **17.3 監査要件**

* Published Policy Versionを変更不可にする。  
* Policy definitionのcanonical JSON checksumを保持する。  
* Materialized Flowを保持し、当時の承認経路を復元可能にする。  
* Decision Logはappend-onlyとし、actor/time/commentを保持する。  
* snapshot/dynamicのどちらで解決したかをapproval task/eventに保持する。  
* ActionRequestのactor / authority principal / delegation grant・chain / origin、actionFingerprint、EvaluationSnapshot/checksum、適用PolicyBinding/Policy Version、Approval Plan/checksum、interpreterSemanticsVersion、MaterializedStepId、および承認時のauthorization target（object/relation）をDecisionまたはAudit eventから追跡可能にする。

## **17.4 Cloudflare Queuesへの配送**

* D1へのdomain event/read projection/outbox更新とQueue送信は同一トランザクションにはしない。Workflowのstep.do()でD1側をidempotentに確定し、Outbox Dispatcher Workerが未配送eventをCloudflare Queuesへ送信する。Queue consumerはat-least-onceを前提にidempotentに実装し、retryとDead Letter Queueを設定する。
