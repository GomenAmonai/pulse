from httpx import AsyncClient

from app.security import create_token
from tests.factories import register

CREDS = {"email": "owner@example.com", "password": "correct-horse"}


async def test_register_returns_working_tokens(client: AsyncClient):
    response = await client.post("/api/auth/register", json=CREDS)
    assert response.status_code == 201
    tokens = response.json()
    me = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {tokens['access']}"})
    assert me.status_code == 200
    assert me.json()["email"] == "owner@example.com"


async def test_email_is_unique_case_insensitively(client: AsyncClient):
    await register(client)
    response = await client.post("/api/auth/register", json=CREDS | {"email": "Owner@Example.com"})
    assert response.status_code == 409
    assert response.json()["code"] == "email_taken"


async def test_short_password_is_rejected(client: AsyncClient):
    response = await client.post("/api/auth/register", json=CREDS | {"password": "short"})
    assert response.status_code == 422


async def test_login(client: AsyncClient):
    await register(client)
    assert (await client.post("/api/auth/login", json=CREDS)).status_code == 200
    wrong = await client.post("/api/auth/login", json=CREDS | {"password": "wrong-horse"})
    assert wrong.status_code == 401
    unknown = await client.post("/api/auth/login", json=CREDS | {"email": "nobody@example.com"})
    assert unknown.status_code == 401
    # Same message either way: the endpoint doesn't confirm which emails are registered.
    assert wrong.json() == unknown.json()


async def test_refresh(client: AsyncClient):
    tokens = (await client.post("/api/auth/register", json=CREDS)).json()
    response = await client.post("/api/auth/refresh", json={"refresh": tokens["refresh"]})
    assert response.status_code == 200
    assert (
        await client.get("/api/auth/me", headers={"Authorization": f"Bearer {response.json()['access']}"})
    ).is_success


async def test_token_types_are_not_interchangeable(client: AsyncClient):
    tokens = (await client.post("/api/auth/register", json=CREDS)).json()
    me = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {tokens['refresh']}"})
    assert me.status_code == 401
    refresh = await client.post("/api/auth/refresh", json={"refresh": tokens["access"]})
    assert refresh.status_code == 401


async def test_protected_routes_need_a_valid_token(client: AsyncClient):
    assert (await client.get("/api/monitors")).status_code == 401
    garbage = await client.get("/api/monitors", headers={"Authorization": "Bearer nope"})
    assert garbage.status_code == 401
    assert garbage.json()["code"] == "not_authenticated"
    deleted_user = await client.get("/api/monitors", headers={"Authorization": f"Bearer {create_token(999, 'access')}"})
    assert deleted_user.status_code == 401


async def test_login_is_rate_limited_per_ip(client: AsyncClient):
    statuses = [(await client.post("/api/auth/login", json=CREDS)).status_code for _ in range(11)]
    assert statuses[:10] == [401] * 10
    assert statuses[10] == 429
    response = await client.post("/api/auth/login", json=CREDS)
    assert response.json()["code"] == "rate_limited"
    assert 1 <= int(response.headers["Retry-After"]) <= 60
