# **11\. Flow MaterializationとCloudflare Workflows実行モデル**

## **11.1 Materialization**

ActionRequest受付時にAction Definition / Standard Schema validationとAction Authorizationを行い、認可済みrequestに対してPolicyBindingResolverが適用Binding群を確定する。Bindingごとに固定したPublished Policy Versionをfirst-matchで評価し、FieldExpression・ObjectExpression・PrincipalExpressionを解決した結果をApprovalPlanCompilerで合成してMaterialized Approval Planを生成する。Materialized Planは\`interpreterSemanticsVersion\`、適用Binding/Policy Version snapshot、EvaluationSnapshot checksum、Materialized Flow、各nodeのMaterializedStepIdを保持する。MaterializedStepIdは\`policyBindingId \+ policyVersion \+ flowPath\`を正規入力として決定的に生成し、Policy-localな\`stepKey\`とは分離する。Workflow event名、D1 task/decision identity、durable step名はMaterializedStepIdを使用し、stepKeyはUI/監査表示用に保持する。合成結果が\`none\`ならWorkflow instanceを作成せずRe-Authorization後にActionExecutorへ進む。実行中のPolicy/Binding変更や評価Context変更は既存Planへ反映しない。

ActionRequest \+ Evaluation Context  
            |  
            v  
       PolicyBindingResolver  
            |  
            v  
  applicable Policy Versions  
            |  
            v  
 first-match evaluation per Policy  
            |  
            v  
   ApprovalPlanCompiler  
            |  
            v  
 Materialized Flow AST (\`none\`を含む)  
            |  
     none \-\> Re-Authorization \-\> ActionExecutor  
            |  
     approval flow  
            v  
 Generic ActionWorkflow instance  
            |  
            v  
      Flow Interpreter  
            |  
            v  
 Re-Authorization \-\> ActionExecutor

## **11.2 Generic ActionWorkflow**

Cloudflare Workflowsには承認が必要なActionRequestごとに1 instanceを作成する。Authorizationのみでallowされ承認不要なActionRequestはWorkflowを作成せず直接実行してよい。Workflow class/definitionは単一のGeneric ActionWorkflowとし、instanceごとに異なるMaterialized Approval Planを解釈する。instance IDは原則actionRequestIdと1対1に対応させる。Workflow instance paramsにはFlow本体やsnapshot candidate集合を直接埋め込まず、原則\`{ actionRequestId, approvalPlanChecksum }\`のみを渡す。Workflow開始時のdurable stepでD1からimmutableなMaterialized Planを読み、checksum一致を検証する。snapshot candidate集合が大きい場合はcohortを別テーブルへ保存し、PlanからcohortIdを参照する。

## **11.3 Flow Interpreter**

InterpreterはFlow ASTのnone / serial / parallel(all|any|quorum) / approvalを再帰的に実行する。noneは即時完了するno-opであり、Materialized Flowのrootがnoneの場合は原則Workflow instance自体を作成しない。approval nodeはapproval taskをprojectionし、step.waitForEvent()でdecision eventを待つ。parallel any/quorumはPromise.race()/Promise.any()へ依存せず、decision eventを順次収集するevent collectorとして実装する。reject semanticsはv1で固定する。parallel/allは1 child rejectで即全体reject、parallel/anyは1 child approveで即approve・全child rejectでreject、parallel/quorum(k)はapprove数がk以上でapproveし、\`approved \+ undecided \< k\`になった時点で到達不能として即rejectする。candidateCompletion=all/quorumにも同じ到達不能判定を適用する。
