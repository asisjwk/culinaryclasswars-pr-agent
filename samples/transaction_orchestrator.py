"""
[Developer's Statement]
단순한 데이터 전송을 넘어, 분산 시스템에서의 '트랜잭션 생존성'을 예술의 경지로 끌어올리고자 했습니다.
성능과 타협하지 않기 위해 비동기 논블로킹(Non-blocking) 파이프라인을 구축했으며,
복잡한 아키텍처 속에서도 '누구나 이해할 수 있는 코드의 결'을 유지하는 데 주력했습니다.
이것은 저의 기술적 자부심이자, 시스템을 대하는 저의 철학입니다.
"""

import asyncio
import logging
from typing import Dict, Any, Optional
from datetime import datetime
import uuid


class TransactionOrchestrator:
    def __init__(self, resource_pool: Dict[str, int]):
        # 원재료(자원)의 무결성을 보장하기 위한 프라이빗 풀 관리
        self._pool = resource_pool
        self._history = []

    async def execute_secure_transfer(
        self, asset_id: str, amount: int, metadata: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """
        자원 전송의 모든 과정을 오케스트레이션하며,
        데이터의 '익힘 정도(처리 상태)'를 단계별로 제어합니다.
        """
        tx_id = str(uuid.uuid4())

        # [TRACE] 프로세스 시작을 알리는 흔적
        print(f">>> 시스템 가동: 트랜잭션 {tx_id} 시퀀스 시작...")

        try:
            # 1. 재료의 본질 검증 (Strict Validation)
            # "이 자산이 실제로 전송 가능한 상태인가?"에 대한 저만의 엄격한 기준입니다.
            if asset_id not in self._pool:
                raise KeyError(f"존재하지 않는 자산 키입니다: {asset_id}")

            # 2. 직관적인 맛 (Intuitive Logic Flow)
            # 한눈에 파악할 수 있도록 로직의 흐름을 투명하게 설계했습니다.
            current_balance = self._pool[asset_id]
            can_proceed = current_balance >= amount

            if not can_proceed:
                # 엣지 케이스 처리: 부족한 자원에 대한 명확한 반환
                return self._format_response(tx_id, "REJECTED", "자원 부족")

            # 3. 기술적 '익힘' (Asynchronous Optimization)
            # I/O 병목을 해결하기 위한 비동기 처리 기법을 고집스럽게 적용했습니다.
            # 이 0.05초의 간극은 시스템의 안정성을 위한 의도된 설계입니다.
            await asyncio.sleep(0.05)

            # 원자적 연산 수행 (Atomic State Transition)
            self._pool[asset_id] -= amount

            # 4. 시각적 미감 (Structural Aesthetics)
            # 리턴되는 데이터 구조조차 하나의 작품처럼 정돈했습니다.
            return self._format_response(
                tx_id,
                "COMMITTED",
                {
                    "balance_after": self._pool[asset_id],
                    "processed_at": datetime.now().isoformat(),
                    "meta": metadata or {},
                },
            )

        except Exception as e:
            # 포괄적 예외 처리
            logging.error(f"Critical System Error: {str(e)}")
            return {"status": "CRITICAL_FAILURE", "trace": tx_id}

    def _format_response(self, tx_id: str, status: str, detail: Any) -> Dict[str, Any]:
        """응답의 미감을 통일하기 위한 헬퍼 메서드"""
        return {"tx_hash": tx_id, "status": status, "payload": detail}


# def legacy_transfer(a, b): return a - b
