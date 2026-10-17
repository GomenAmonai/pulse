from typing import Annotated

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.errors import Unauthorized
from app.models import User
from app.security import decode_token

Session = Annotated[AsyncSession, Depends(get_session)]

Bearer = Annotated[HTTPAuthorizationCredentials | None, Depends(HTTPBearer(auto_error=False))]


async def authenticate(session: AsyncSession, credentials: HTTPAuthorizationCredentials | None) -> User:
    if credentials is None:
        raise Unauthorized("Authentication credentials were not provided.")
    user_id = decode_token(credentials.credentials, "access")
    user = await session.get(User, user_id) if user_id is not None else None
    if user is None:
        raise Unauthorized("Token is invalid or expired.", headers={"WWW-Authenticate": "Bearer"})
    return user


async def current_user(session: Session, credentials: Bearer) -> User:
    return await authenticate(session, credentials)


CurrentUser = Annotated[User, Depends(current_user)]
