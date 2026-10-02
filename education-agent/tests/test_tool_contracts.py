"""工具契约的结构性保证（T-18 验收：工具不可指定任意用户或审批）。不依赖运行时 call，现在就应该通过。"""
import json

import pytest
from pydantic import ValidationError

from education_agent.tools.contracts import TOOL_SPECS, EnrollmentArgs, PrepareApplicationArgs

FORBIDDEN_TOOL_WORDS = ("approve", "confirm", "refund", "reject", "execute", "sql", "cypher", "http", "fetch")
IDENTITY_FIELDS = {"studentid", "actorid", "userid", "user", "student", "role", "actor", "requestid", "token"}


def test_tool_names_are_the_designed_allowlist():
    assert {s.name for s in TOOL_SPECS} == {
        "getCurrentOffering", "getMyEnrollment", "getMySchedule", "getMyProgress",
        "getTransferTargets", "prepareApplication", "getApplicationStatus", "searchKnowledge",
    }


def test_no_approval_or_arbitrary_execution_tool():
    for s in TOOL_SPECS:
        lowered = s.name.lower()
        assert not any(w in lowered for w in FORBIDDEN_TOOL_WORDS), s.name


def test_no_tool_schema_exposes_an_identity_field():
    for s in TOOL_SPECS:
        props = s.args_model.model_json_schema().get("properties", {})
        assert not (IDENTITY_FIELDS & {k.lower() for k in props}), f"{s.name} 的参数里出现了身份字段: {props.keys()}"


def test_every_schema_forbids_additional_properties():
    for s in TOOL_SPECS:
        assert s.args_model.model_json_schema().get("additionalProperties") is False, s.name


@pytest.mark.parametrize("extra", ["studentId", "actorId", "userId", "role"])
def test_model_supplied_identity_is_rejected_not_ignored(extra):
    with pytest.raises(ValidationError):
        EnrollmentArgs.model_validate({"enrollmentId": "00000000-0000-0000-0000-000000000501", extra: "x"})


def test_prepare_application_validates_type_and_reason():
    ok = {"type": "transfer", "enrollmentId": "00000000-0000-0000-0000-000000000501", "reason": "冲突"}
    PrepareApplicationArgs.model_validate(ok)
    with pytest.raises(ValidationError):
        PrepareApplicationArgs.model_validate({**ok, "type": "approve"})
    with pytest.raises(ValidationError):
        PrepareApplicationArgs.model_validate({**ok, "reason": ""})
    with pytest.raises(ValidationError):
        PrepareApplicationArgs.model_validate({**ok, "enrollmentId": "not-a-uuid"})


def test_schemas_are_json_serializable_for_the_model():
    from education_agent.tools.runtime import ToolRuntime
    import httpx

    schemas = ToolRuntime(TOOL_SPECS, httpx.AsyncClient()).schemas()
    json.dumps(schemas)
    assert len(schemas) == len(TOOL_SPECS)
