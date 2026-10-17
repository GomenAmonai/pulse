from fastapi import APIRouter, Depends, status
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.config import get_settings
from app.deps import CurrentUser, Session
from app.errors import EmailTaken, Unauthorized
from app.models import User
from app.ratelimit import RateLimit
from app.schemas import AccessToken, Credentials, RefreshIn, TokenPair, UserOut
from app.security import DUMMY_HASH, create_token, decode_token, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])

_limit = get_settings().login_rate_limit


def _pair(user: User) -> TokenPair:
    return TokenPair(access=create_token(user.id, "access"), refresh=create_token(user.id, "refresh"))


@router.post(
    "/register",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(RateLimit("register", _limit))],
)
async def register(body: Credentials, session: Session) -> TokenPair:
    # Argon2 is deliberately slow (~50 ms); keep it off the event loop.
    user = User(email=body.email.lower(), password_hash=await run_in_threadpool(hash_password, body.password))
    session.add(user)
    try:
        await session.commit()
    except IntegrityError:
        raise EmailTaken("An account with this email already exists.") from None
    return _pair(user)


@router.post("/login", dependencies=[Depends(RateLimit("login", _limit))])
async def login(body: Credentials, session: Session) -> TokenPair:
    user = await session.scalar(select(User).where(User.email == body.email.lower()))
    # Hash anyway when the user doesn't exist, so response time doesn't reveal registered emails.
    valid = await run_in_threadpool(verify_password, body.password, user.password_hash if user else DUMMY_HASH)
    if not valid or user is None:
        raise Unauthorized("Email or password is incorrect.")
    return _pair(user)


@router.post("/refresh")
async def refresh(body: RefreshIn, session: Session) -> AccessToken:
    user_id = decode_token(body.refresh, "refresh")
    if user_id is None or await session.get(User, user_id) is None:
        raise Unauthorized("Refresh token is invalid or expired.")
    return AccessToken(access=create_token(user_id, "access"))


@router.get("/me")
async def me(user: CurrentUser) -> UserOut:
    return UserOut.model_validate(user)
